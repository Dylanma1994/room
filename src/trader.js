const { ethers } = require("ethers");

class Trader {
  constructor(provider, wallet, contractAddress, abi, portfolio, config = {}) {
    this.provider = provider;
    this.wallet = wallet;
    this.contractAddress = contractAddress;
    this.contract = new ethers.Contract(contractAddress, abi, wallet);
    this.portfolio = portfolio;
    this.config = config || {};

    // 卖出队列（串行）
    this.sellQueue = [];
    this.isProcessingSellQueue = false;

    // 当前是否有交易在进行（用于买入冲突拦截、卖出串行）
    this.isTrading = false;
  }

  async buyToken(tokenAddress, amount = 1, curveIndex = 0) {
    // 买入遇到冲突直接拦截，不入队
    if (this.isTrading) {
      console.log("⚠️  交易正在进行中，请稍后...");
      return { success: false, error: "交易正在进行中，请稍后" };
    }

    this.isTrading = true;

    try {
      console.log(
        `🛒 买入代币: ${tokenAddress} (数量: ${amount}, 曲线: ${curveIndex})`
      );

      // 确保参数类型正确
      const validTokenAddress = ethers.getAddress(tokenAddress);
      const validAmount = BigInt(amount);
      const validCurveIndex = BigInt(curveIndex);

      // 编码交易数据
      let encodedData;
      try {
        encodedData = this.contract.interface.encodeFunctionData("buyShares", [
          validTokenAddress,
          validAmount,
          validCurveIndex,
        ]);
      } catch (encodeError) {
        console.error("❌ 交易数据编码失败:", encodeError);
        return {
          success: false,
          error: `交易数据编码失败: ${encodeError.message}`,
        };
      }

      // 构建并发送交易 (使用 EIP-1559)
      const fee = await this.provider.getFeeData();
      const boost = Number(this.config.gasBoostMultiplier ?? 1);
      const scale = 10000n; // 4 位小数精度
      const boostScaled = BigInt(
        Math.floor(Math.max(1, boost) * Number(scale))
      );
      const tipOverride = this.config.gasTipGwei
        ? ethers.parseUnits(String(this.config.gasTipGwei), "gwei")
        : fee.maxPriorityFeePerGas
        ? (fee.maxPriorityFeePerGas * boostScaled) / scale
        : null;
      const maxFeeOverride = fee.maxFeePerGas
        ? (fee.maxFeePerGas * boostScaled) / scale
        : null;

      // 整理费率并确保 maxFee >= priorityFee
      let finalTip = tipOverride;
      let finalMaxFee = maxFeeOverride;

      if (!finalTip && fee.maxPriorityFeePerGas) {
        finalTip = (fee.maxPriorityFeePerGas * boostScaled) / scale;
      }
      if (!finalMaxFee && fee.maxFeePerGas) {
        finalMaxFee = (fee.maxFeePerGas * boostScaled) / scale;
      }
      if (!finalMaxFee && fee.gasPrice) {
        finalMaxFee = fee.gasPrice;
      }
      if (!finalTip && fee.gasPrice) {
        finalTip = fee.gasPrice / 2n;
      }
      if (finalTip && finalMaxFee && finalMaxFee <= finalTip) {
        finalMaxFee = finalTip * 2n; // 至少为 tip 的 2 倍
      }
      if (!finalMaxFee && finalTip) {
        finalMaxFee = finalTip * 2n;
      }

      const txData = {
        to: this.contractAddress,
        data: encodedData,
        // 使用网络默认的 gasLimit 与 EIP-1559 费率，不做手动覆盖
        ...(this.config.usePendingNonce
          ? {
              nonce: await this.provider.getTransactionCount(
                this.wallet.address,
                "pending"
              ),
            }
          : {}),
      };

      // 使用默认 Gas/费率，打印简要说明
      const tipGweiLog = "-(default)";
      const maxFeeGweiLog = "-(default)";
      console.log(
        `🧾 提交费率: 使用网络默认 (maxPriority=${tipGweiLog}, maxFee=${maxFeeGweiLog}, gasLimit=auto)`
      );

      const tx = await this.wallet.sendTransaction(txData);

      console.log(`📤 交易发送: ${tx.hash}`);

      // 等待交易确认
      const receipt = await tx.wait();

      if (receipt.status === 1) {
        const effPrice = receipt.effectiveGasPrice ?? 0n;
        const gasUsed = receipt.gasUsed ?? 0n;
        const priceGwei = ethers.formatUnits(effPrice, "gwei");
        const costEth = ethers.formatEther(gasUsed * effPrice);
        console.log(
          `✅ 买入成功! tx=${tx.hash}, 区块=${
            receipt.blockNumber
          }, gasUsed=${gasUsed.toString()}, gasPrice=${priceGwei} gwei, cost=${costEth} ETH`
        );

        // 添加到持仓
        await this.portfolio.addToken(
          tokenAddress,
          amount,
          tx.hash,
          Date.now()
        );

        return {
          success: true,
          txHash: tx.hash,
          blockNumber: receipt.blockNumber,
          gasUsed: gasUsed.toString(),
          gasPriceGwei: priceGwei,
          gasCostEth: costEth,
        };
      } else {
        console.log(`❌ 买入失败: 交易被回滚`);
        return { success: false, error: "交易被回滚" };
      }
    } catch (error) {
      console.error(`❌ 买入失败:`, error);

      // 解析错误信息
      let errorMessage = error.message;
      if (error.code === "INSUFFICIENT_FUNDS") {
        errorMessage = "余额不足";
      } else if (error.code === "UNPREDICTABLE_GAS_LIMIT") {
        errorMessage = "无法预测 Gas 限制，可能是合约调用失败";
      }

      return { success: false, error: errorMessage };
    } finally {
      this.isTrading = false;
    }
  }

  async sellToken(tokenAddress, amount = null) {
    // 入队卖出请求；队列会串行执行，避免 nonce 冲突
    return await new Promise(async (resolve) => {
      // 简要记录当前请求（不做强校验，实际执行时再次校验）
      this.sellQueue.push({ tokenAddress, amount, resolve });
      this._processSellQueue();
    });
  }

  async _processSellQueue() {
    if (this.isProcessingSellQueue) return;
    this.isProcessingSellQueue = true;

    try {
      while (this.sellQueue.length > 0) {
        const job = this.sellQueue.shift();
        const { tokenAddress } = job;
        let { amount } = job;

        try {
          // 计算实际卖出数量
          if (amount === null) {
            amount = await this.portfolio.getTokenAmount(tokenAddress);
            if (!amount || amount <= 0) {
              console.log(`⚠️  没有持有该代币: ${tokenAddress}`);
              job.resolve({ success: false, error: "没有持有该代币" });
              continue;
            }
            console.log(`🔄 准备卖出全部代币: ${amount}`);
          }

          // 如果有交易在进行（买入或其他卖出），等待其完成
          if (this.isTrading) {
            // 将当前任务插回队列尾部，并稍后再试
            this.sellQueue.push({ tokenAddress, amount, resolve: job.resolve });
            // 避免忙等，稍作等待
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }

          // 设置交易进行中标志（供买入冲突拦截）
          this.isTrading = true;

          const result = await this._performSell(tokenAddress, amount);
          job.resolve(result);
        } catch (error) {
          console.error("❌ 队列卖出执行出错:", error);
          job.resolve({
            success: false,
            error: error.message || String(error),
          });
        } finally {
          this.isTrading = false;
          // 并给下一个任务一点点间隔，避免 nonce 紧挨
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    } finally {
      this.isProcessingSellQueue = false;
    }
  }

  async _performSell(tokenAddress, amount) {
    try {
      console.log(`💸 准备卖出代币:`);
      console.log(`   代币地址: ${tokenAddress}`);
      console.log(`   数量: ${amount}`);

      // 检查持仓
      const holdingAmount = await this.portfolio.getTokenAmount(tokenAddress);
      if (holdingAmount < amount) {
        console.log(`⚠️  持仓不足: 持有 ${holdingAmount}, 尝试卖出 ${amount}`);
        return { success: false, error: "持仓不足" };
      }

      // 估算 gas 费用
      let gasEstimate;
      try {
        gasEstimate = await this.contract.sellShares.estimateGas(
          tokenAddress,
          amount
        );
        console.log(`⛽ 预估 Gas: ${gasEstimate.toString()}`);
      } catch (error) {
        // 如果因为最后一股导致的估算报错，标记为延后卖出并返回成功（由外部买入触发再卖）
        const msg = (error?.shortMessage || error?.message || "").toLowerCase();
        if (msg.includes("cannot sell the last share")) {
          await this.portfolio.markDeferredSell(tokenAddress);
          console.log(
            "🕒 估算提示: last share，已标记延迟卖出，等待外部买入再卖"
          );
          return {
            success: true,
            txHash: null,
            blockNumber: null,
            gasUsed: null,
          };
        }
        // 新增：合约返回 Insufficient shares，直接返回失败，供上层跳过后续尝试
        if (msg.includes("insufficient shares")) {
          console.error("Gas 估算失败: Insufficient shares");
          return { success: false, error: "Insufficient shares" };
        }
        console.error("Gas 估算失败:", error);
        gasEstimate = 300000;
      }

      // 获取当前 gas price
      const gasPrice = await this.provider.getFeeData();
      console.log(
        `💨 Gas Price: ${ethers.formatUnits(gasPrice.gasPrice, "gwei")} Gwei`
      );

      // 执行卖出交易
      try {
        const tx = await this.contract.sellShares(tokenAddress, amount, {
          gasLimit: gasEstimate,
          gasPrice: gasPrice.gasPrice,
        });

        console.log(`📤 交易已发送: ${tx.hash}`);
        console.log(`⏳ 等待交易确认...`);

        // 等待交易确认
        const receipt = await tx.wait();

        if (receipt.status === 1) {
          console.log(`✅ 卖出成功!`);
          console.log(`   交易哈希: ${tx.hash}`);
          console.log(`   Gas 使用: ${receipt.gasUsed.toString()}`);
          console.log(`   区块号: ${receipt.blockNumber}`);

          // 从持仓中移除
          await this.portfolio.removeToken(tokenAddress, amount);

          return {
            success: true,
            txHash: tx.hash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
          };
        } else {
          console.log(`❌ 卖出失败: 交易被回滚`);
          return { success: false, error: "交易被回滚" };
        }
      } catch (sendError) {
        const msg = (
          sendError?.shortMessage ||
          sendError?.message ||
          ""
        ).toLowerCase();
        if (msg.includes("cannot sell the last share")) {
          await this.portfolio.markDeferredSell(tokenAddress);
          console.log(
            "🕒 发送提示: last share，已标记延迟卖出，等待外部买入再卖"
          );
          return {
            success: true,
            txHash: null,
            blockNumber: null,
            gasUsed: null,
          };
        }
        // 新增：Insufficient shares 直接返回失败
        if (msg.includes("insufficient shares")) {
          console.log("🛑 发送失败: Insufficient shares");
          return { success: false, error: "Insufficient shares" };
        }
        throw sendError;
      }
    } catch (error) {
      console.error(`❌ 卖出失败:`, error);

      let errorMessage = error.message;
      if (error.code === "INSUFFICIENT_FUNDS") {
        errorMessage = "余额不足支付 Gas 费";
      }

      return { success: false, error: errorMessage };
    }
  }

  async sellAllTokens() {
    const tokens = await this.portfolio.getAllTokens();
    const results = [];

    console.log(`🔄 准备卖出所有代币，共 ${tokens.length} 个`);

    for (const tokenAddress of tokens) {
      console.log(`\n--- 卖出代币: ${tokenAddress} ---`);
      const result = await this.sellToken(tokenAddress);
      results.push({ tokenAddress, ...result });

      // 交易间隔，避免 nonce 冲突
      if (result.success) {
        console.log("⏳ 等待 3 秒后继续下一个交易...");
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }

    return results;
  }

  getStatus() {
    return {
      isTrading: this.isTrading,
      walletAddress: this.wallet.address,
      contractAddress: this.contractAddress,
    };
  }
}

module.exports = Trader;
