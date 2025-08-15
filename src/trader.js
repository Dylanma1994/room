const { ethers } = require("ethers");

class Trader {
  constructor(provider, wallet, contractAddress, abi, portfolio) {
    this.provider = provider;
    this.wallet = wallet;
    this.contractAddress = contractAddress;
    this.contract = new ethers.Contract(contractAddress, abi, wallet);
    this.portfolio = portfolio;
    this.isTrading = false;
  }

  async buyToken(tokenAddress, amount = 1, curveIndex = 0) {
    if (this.isTrading) {
      console.log("⚠️  交易正在进行中，请稍后...");
      return false;
    }

    this.isTrading = true;

    try {
      console.log(`🛒 准备买入代币:`);
      console.log(`   代币地址: ${tokenAddress}`);
      console.log(`   数量: ${amount}`);
      console.log(`   曲线索引: ${curveIndex}`);

      // 调试：检查合约方法
      console.log(`🔧 调试信息:`);
      console.log(`   合约地址: ${this.contract.target}`);
      console.log(`   buyShares 方法存在: ${!!this.contract.buyShares}`);
      console.log(`   interface 存在: ${!!this.contract.interface}`);
      if (this.contract.interface && this.contract.interface.functions) {
        console.log(
          `   合约方法数量: ${
            Object.keys(this.contract.interface.functions).length
          }`
        );
      }

      // 检查钱包余额
      const balance = await this.wallet.provider.getBalance(
        this.wallet.address
      );
      console.log(`💰 钱包余额: ${ethers.formatEther(balance)} ETH`);

      // 获取买入价格
      // let buyPrice;
      // try {
      //   buyPrice = await this.contract.getBuyPriceAfterFee(
      //     tokenAddress,
      //     amount
      //   );
      //   console.log(`💰 买入价格: ${buyPrice.toString()} wei`);
      // } catch (error) {
      //   console.error("获取买入价格失败:", error);
      //   return { success: false, error: "无法获取买入价格" };
      // }

      // 使用高 Gas 价格确保交易快速执行
      const feeData = await this.provider.getFeeData();
      const baseGasPrice = feeData.gasPrice;
      const highGasPrice = (baseGasPrice * 150n) / 100n; // 提高50%的Gas价格

      console.log(
        `💨 基础 Gas Price: ${ethers.formatUnits(baseGasPrice, "gwei")} Gwei`
      );
      console.log(
        `💨 使用 Gas Price: ${ethers.formatUnits(highGasPrice, "gwei")} Gwei`
      );

      // 使用固定的 Gas 限制
      const gasLimit = 200000; // 进一步增加 Gas 限制
      console.log(`⛽ 使用 Gas 限制: ${gasLimit}`);

      // 执行买入交易
      const tx = await this.contract.buyShares(
        tokenAddress,
        amount,
        curveIndex,
        {
          gasLimit: gasLimit,
          gasPrice: highGasPrice,
        }
      );

      console.log(`📤 交易已发送: ${tx.hash}`);
      console.log(`⏳ 等待交易确认...`);

      // 等待交易确认
      const receipt = await tx.wait();

      if (receipt.status === 1) {
        console.log(`✅ 买入成功!`);
        console.log(`   交易哈希: ${tx.hash}`);
        console.log(`   Gas 使用: ${receipt.gasUsed.toString()}`);
        console.log(`   区块号: ${receipt.blockNumber}`);

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
          gasUsed: receipt.gasUsed.toString(),
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
    if (this.isTrading) {
      console.log("⚠️  交易正在进行中，请稍后...");
      return false;
    }

    this.isTrading = true;

    try {
      // 如果没有指定数量，卖出全部
      if (amount === null) {
        amount = await this.portfolio.getTokenAmount(tokenAddress);
        if (amount === 0) {
          console.log(`⚠️  没有持有该代币: ${tokenAddress}`);
          return { success: false, error: "没有持有该代币" };
        }
        console.log(`🔄 准备卖出全部代币: ${amount}`);
      }

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
        console.error("Gas 估算失败:", error);
        gasEstimate = 300000;
      }

      // 获取当前 gas price
      const gasPrice = await this.provider.getFeeData();
      console.log(
        `💨 Gas Price: ${ethers.formatUnits(gasPrice.gasPrice, "gwei")} Gwei`
      );

      // 执行卖出交易
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
    } catch (error) {
      console.error(`❌ 卖出失败:`, error);

      let errorMessage = error.message;
      if (error.code === "INSUFFICIENT_FUNDS") {
        errorMessage = "余额不足支付 Gas 费";
      }

      return { success: false, error: errorMessage };
    } finally {
      this.isTrading = false;
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
