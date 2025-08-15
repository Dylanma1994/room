const { ethers } = require("ethers");
const fs = require("fs-extra");
const path = require("path");

class ContractMonitor {
  constructor(provider, contractAddress, abi, onNewToken, onExternalBuy) {
    this.provider = provider;
    this.contractAddress = contractAddress;
    this.contract = new ethers.Contract(contractAddress, abi, provider);
    this.onNewToken = onNewToken;
    this.onExternalBuy = onExternalBuy; // 当他人买入某代币时的回调
    this.isMonitoring = false;
    this.processedEvents = new Set();
    this.lastBlockFile = path.join("./data", "lastBlock.json");
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.lastEventTime = Date.now();
    this.heartbeatInterval = null;
  }

  async init() {
    // 确保数据目录存在
    await fs.ensureDir("./data");

    // 加载上次处理的区块号
    this.lastProcessedBlock = await this.loadLastBlock();
  }

  async loadLastBlock() {
    try {
      if (await fs.pathExists(this.lastBlockFile)) {
        const data = await fs.readJson(this.lastBlockFile);
        return data.lastBlock || 0;
      }
    } catch (error) {
      console.error("加载上次区块号失败:", error);
    }
    // 如果没有记录，从当前区块开始
    const currentBlock = await this.provider.getBlockNumber();
    return currentBlock;
  }

  async saveLastBlock(blockNumber) {
    try {
      await fs.writeJson(this.lastBlockFile, { lastBlock: blockNumber });
    } catch (error) {
      console.error("保存区块号失败:", error);
    }
  }

  async startMonitoring() {
    if (this.isMonitoring) {
      console.log("⚠️  监控已经在运行中");
      return;
    }

    console.log(`🚀 开始监控合约: ${this.contractAddress}`);
    console.log(`📍 使用 WebSocket 实时监听 Trade 事件`);

    this.isMonitoring = true;

    // 设置事件监听器，添加错误处理和重连机制
    this.setupEventListener();

    console.log("✅ 监控启动完成，等待新代币创建事件...");
  }

  setupEventListener() {
    // 监听 Trade 事件
    this.contract.on(
      "Trade",
      async (
        trader,
        subject,
        isBuy,
        shareAmount,
        tokenAmount,
        protocolTokenAmount,
        subjectTokenAmount,
        supply,
        multiplier,
        event
      ) => {
        if (!this.isMonitoring) return;

        try {
          // 记录最后收到事件的时间
          this.lastEventTime = Date.now();

          await this.processTradeEvent(event, {
            trader,
            subject,
            isBuy,
            shareAmount,
            tokenAmount,
            protocolTokenAmount,
            subjectTokenAmount,
            supply,
            multiplier,
          });
        } catch (error) {
          console.error("处理 Trade 事件时出错:", error);
        }
      }
    );

    // 启动心跳检测
    this.startHeartbeat();

    // 监听 provider 错误并重连
    this.provider.on("error", (error) => {
      console.error("Provider 错误:", error.message);
      if (
        this.isMonitoring &&
        this.reconnectAttempts < this.maxReconnectAttempts
      ) {
        console.log(
          `🔄 尝试重新连接... (${this.reconnectAttempts + 1}/${
            this.maxReconnectAttempts
          })`
        );
        this.reconnectAttempts++;
        setTimeout(() => {
          if (this.isMonitoring) {
            this.reconnect();
          }
        }, 5000);
      } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        console.error("❌ 达到最大重连次数，停止监控");
        this.stopMonitoring();
      }
    });

    // 重置重连计数器当连接成功时
    this.provider.on("network", (newNetwork, oldNetwork) => {
      if (oldNetwork) {
        console.log(`🔄 网络切换: ${oldNetwork.name} -> ${newNetwork.name}`);
      }
      this.reconnectAttempts = 0; // 重置重连计数器
    });
  }

  startHeartbeat() {
    // 每30秒检查一次连接状态
    this.heartbeatInterval = setInterval(() => {
      if (!this.isMonitoring) return;

      const now = Date.now();
      const timeSinceLastEvent = now - this.lastEventTime;

      // 每30秒显示状态
      console.log(`📊 监听中 (${Math.floor(timeSinceLastEvent / 1000)}s)`);

      // 如果超过2分钟没有收到事件，检查连接状态
      if (timeSinceLastEvent > 120000) {
        console.log("⚠️  长时间未收到事件，检查连接状态...");
        this.checkConnection();
      }
    }, 30000);
  }

  async checkConnection() {
    try {
      // 尝试获取最新区块号来测试连接
      const blockNumber = await this.provider.getBlockNumber();
      console.log(`✅ 连接正常，当前区块: ${blockNumber}`);
      this.lastEventTime = Date.now(); // 重置时间
    } catch (error) {
      console.error("连接检查失败:", error);
      if (this.isMonitoring) {
        console.log("🔄 尝试重新连接...");
        this.reconnect();
      }
    }
  }

  async reconnect() {
    try {
      console.log("🔄 重新建立连接...");

      // 清除心跳检测
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
      }

      // 移除旧的监听器
      this.contract.removeAllListeners("Trade");
      this.provider.removeAllListeners();

      // 重新设置监听器
      this.setupEventListener();

      console.log("✅ 重连成功");
      this.reconnectAttempts = 0; // 重置计数器
      this.lastEventTime = Date.now(); // 重置时间
    } catch (error) {
      console.error("重连失败:", error);
      if (
        this.isMonitoring &&
        this.reconnectAttempts < this.maxReconnectAttempts
      ) {
        setTimeout(() => this.reconnect(), 10000);
      }
    }
  }

  async processTradeEvent(event, tradeData) {
    try {
      // 确保事件数据有效
      if (!tradeData || !tradeData.subject) {
        console.log("⚠️  收到无效事件数据，跳过处理");
        return;
      }

      const txHash =
        event?.log?.transactionHash || event?.transactionHash || "unknown";
      const blockNumber = event?.log?.blockNumber || event?.blockNumber;
      const eventId = `${txHash}-${event?.log?.index || 0}`;

      // 避免重复处理
      if (this.processedEvents.has(eventId)) {
        return;
      }
      this.processedEvents.add(eventId);

      const { subject, isBuy, supply } = tradeData;

      // 简化日志，只记录关键决策信息
      if (isBuy) {
        if (supply.toString() === "1") {
          console.log(`🎉 新代币创建: ${subject} (供应量=1) - 准备买入!`);
        } else {
          // 仅在买入时简要记录
          console.log(
            `🟢 侦测到买入: ${subject} (供应量=${supply.toString()})`
          );
        }
      }
      // 卖出事件不记录，减少日志噪音

      // 检查是否是新代币创建 (仅判断 supply=1)
      if (isBuy && supply.toString() === "1") {
        // 异步处理新代币，不阻塞事件监听
        if (this.onNewToken) {
          // 使用 setImmediate 确保不阻塞事件循环
          setImmediate(async () => {
            try {
              // 传递 multiplier 作为 curveIndex
              await this.onNewToken(
                subject,
                txHash,
                blockNumber || 0,
                tradeData.multiplier
              );
            } catch (error) {
              console.error("处理新代币时出错:", error);
            }
          });
        }
      }

      // 对所有买入事件调用外部买入回调（由上层自行过滤是否需要卖出）
      if (isBuy && this.onExternalBuy) {
        setImmediate(async () => {
          try {
            await this.onExternalBuy({
              subject,
              trader: tradeData.trader,
              isBuy,
              supply: supply?.toString?.() || String(supply),
              txHash,
              blockNumber: blockNumber || 0,
            });
          } catch (error) {
            console.error("处理外部买入回调时出错:", error);
          }
        });
      }

      // 更新最后处理的区块号
      if (blockNumber && blockNumber > this.lastProcessedBlock) {
        this.lastProcessedBlock = blockNumber;
        await this.saveLastBlock(blockNumber);
      }
    } catch (error) {
      console.error(`处理 Trade 事件失败:`, error);
      console.error(`事件数据:`, { event, tradeData });
    }
  }

  async waitForTransactionConfirmation(txHash) {
    try {
      console.log(`⏳ 等待交易确认: ${txHash}`);

      // 等待交易被确认
      const receipt = await this.provider.waitForTransaction(txHash, 1); // 等待1个确认

      if (receipt && receipt.status === 1) {
        console.log(`✅ 交易已确认: ${txHash} (区块: ${receipt.blockNumber})`);
        return receipt;
      } else {
        console.log(`❌ 交易失败: ${txHash}`);
        throw new Error(`交易失败: ${txHash}`);
      }
    } catch (error) {
      console.error(`❌ 等待交易确认失败: ${txHash}`, error.message);
      throw error;
    }
  }

  stopMonitoring() {
    if (!this.isMonitoring) {
      console.log("⚠️  监控未在运行");
      return;
    }

    console.log("🛑 停止监控...");
    this.isMonitoring = false;

    // 清除心跳检测
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // 移除所有监听器
    this.contract.removeAllListeners("Trade");
    this.provider.removeAllListeners();

    console.log("✅ 监控已停止");
  }

  getStatus() {
    return {
      isMonitoring: this.isMonitoring,
      contractAddress: this.contractAddress,
      lastProcessedBlock: this.lastProcessedBlock,
      processedEventsCount: this.processedEvents.size,
    };
  }
}

module.exports = ContractMonitor;
