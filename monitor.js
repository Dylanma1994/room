#!/usr/bin/env node

const { ethers } = require("ethers");
const fs = require("fs-extra");
const ContractMonitor = require("./src/monitor");
const SqliteCandidateStore = require("./src/candidatesSqlite");

class MonitorBot {
  constructor() {
    this.configFile = "./config.json";
    this.abiFile = "./abi/contract.json";
    this.isRunning = false;
  }

  async loadConfig() {
    if (!(await fs.pathExists(this.configFile))) {
      console.log("❌ 配置文件不存在，请先创建 config.json");
      process.exit(1);
    }
    return await fs.readJson(this.configFile);
  }

  async loadABI() {
    if (!(await fs.pathExists(this.abiFile))) {
      console.log("❌ ABI 文件不存在:", this.abiFile);
      process.exit(1);
    }
    return await fs.readJson(this.abiFile);
  }

  async init() {
    try {
      console.log("🚀 初始化监控机器人...");

      // 加载配置和 ABI
      this.config = await this.loadConfig();
      this.abi = await this.loadABI();

      // 验证配置
      this.validateConfig();

      // 创建 provider
      console.log(`🔌 使用 HTTP 连接: ${this.config.rpcUrl}`);
      this.provider = new ethers.JsonRpcProvider(this.config.rpcUrl);

      // 测试连接
      const network = await this.provider.getNetwork();
      console.log(
        `🌐 连接到网络: ${network.name} (Chain ID: ${network.chainId})`
      );

      // 候选存储
      this.candidates = new SqliteCandidateStore({
        dbPath: this.config.candidateDbPath || "./data/candidates.db",
      });
      await this.candidates.init();

      // 创建监控器
      this.monitor = new ContractMonitor(
        this.provider,
        this.config.contractAddress,
        this.abi,
        this.onNewTokenDetected.bind(this),
        this.onExternalBuyDetected.bind(this),
        { wsUrl: this.config.wsUrl, rpcUrl: this.config.rpcUrl }
      );

      await this.monitor.init();

      console.log("✅ 监控初始化完成");
      console.log(`📍 监控合约: ${this.config.contractAddress}`);
    } catch (error) {
      console.error("❌ 初始化失败:", error);
      process.exit(1);
    }
  }

  validateConfig() {
    const required = ["rpcUrl", "contractAddress"];
    for (const field of required) {
      if (!this.config[field]) {
        throw new Error(`配置文件缺少必要字段: ${field}`);
      }
    }

    // 验证合约地址格式
    if (!ethers.isAddress(this.config.contractAddress)) {
      throw new Error(`无效的合约地址: ${this.config.contractAddress}`);
    }
  }

  // 将 multiplier 转换为 curveIndex
  multiplierToCurveIndex(multiplier) {
    const multiplierValue = multiplier.toString();

    switch (multiplierValue) {
      case "20":
        return 3;
      case "10":
        return 2;
      case "5":
        return 1;
      default:
        console.log(
          `⚠️  未知的 multiplier 值: ${multiplierValue}，使用默认 curveIndex: 0`
        );
        return 0;
    }
  }

  async onNewTokenDetected(tokenAddress, txHash, blockNumber, multiplier) {
    try {
      console.log(`\n🎉 检测到新代币创建!`);
      console.log(`   代币地址: ${tokenAddress}`);
      console.log(`   创建交易: ${txHash}`);
      console.log(`   区块号: ${blockNumber}`);
      console.log(`   Multiplier: ${multiplier}`);

      // 根据 multiplier 计算 curveIndex
      const curveIndex = this.multiplierToCurveIndex(multiplier);
      console.log(`   CurveIndex: ${curveIndex}`);

      // 加入候选列表
      this.candidates.addCandidate({
        address: tokenAddress,
        curveIndex,
        multiplier,
        txHash,
        createdAt: Date.now(),
      });
      console.log("📝 已加入候选代币列表，等待扫描器评估: ", tokenAddress);
    } catch (error) {
      console.error("❌ 处理新代币时出错:", error);
    }
  }

  async onExternalBuyDetected({ subject, trader, isBuy }) {
    // 监控模式下不处理外部买入，只记录
    if (isBuy) {
      console.log(`🟢 外部买入: ${subject} by ${trader}`);
    }
  }

  async start() {
    if (this.isRunning) {
      console.log("⚠️  监控已在运行中");
      return;
    }

    console.log("\n🤖 启动监控机器人...");
    this.isRunning = true;

    // 启动监控
    await this.monitor.startMonitoring();

    // 设置优雅退出
    this.setupGracefulShutdown();

    console.log("\n✅ 监控已启动，按 Ctrl+C 停止");
  }

  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      console.log(`\n🛑 收到 ${signal} 信号，正在关闭监控...`);

      if (this.monitor) {
        this.monitor.stopMonitoring();
      }

      this.isRunning = false;
      console.log("✅ 监控已安全关闭");
      process.exit(0);
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  }
}

// 主函数
async function main() {
  const bot = new MonitorBot();

  try {
    await bot.init();
    await bot.start();
  } catch (error) {
    console.error("❌ 启动失败:", error);
    process.exit(1);
  }
}

// 如果直接运行此文件
if (require.main === module) {
  main();
}

module.exports = MonitorBot;
