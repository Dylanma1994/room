const { ethers } = require("ethers");
const fs = require("fs-extra");
const path = require("path");
const ContractMonitor = require("./src/monitor");
const Portfolio = require("./src/portfolio");
const Trader = require("./src/trader");

class TokenBot {
  constructor() {
    this.configFile = "./config.json";
    this.abiFile = "./abi/contract.json";
    this.isRunning = false;
  }

  async loadConfig() {
    if (!(await fs.pathExists(this.configFile))) {
      console.log("❌ 配置文件不存在，请先创建 config.json");
      console.log("参考 config.example.json 创建配置文件");
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
      console.log("🚀 初始化代币交易机器人...");

      // 加载配置和 ABI
      this.config = await this.loadConfig();
      this.abi = await this.loadABI();

      // 验证配置
      this.validateConfig();

      // 创建 provider - 优先使用 WebSocket 连接
      if (this.config.wsUrl) {
        console.log(`🔌 使用 WebSocket 连接: ${this.config.wsUrl}`);
        this.provider = new ethers.WebSocketProvider(this.config.wsUrl);
      } else {
        console.log(`🔌 使用 HTTP 连接: ${this.config.rpcUrl}`);
        this.provider = new ethers.JsonRpcProvider(this.config.rpcUrl);
      }

      // 测试连接
      const network = await this.provider.getNetwork();
      console.log(
        `🌐 连接到网络: ${network.name} (Chain ID: ${network.chainId})`
      );

      // 创建 wallet
      this.wallet = new ethers.Wallet(this.config.privateKey, this.provider);
      console.log(`👛 钱包地址: ${this.wallet.address}`);

      // 检查余额
      const balance = await this.provider.getBalance(this.wallet.address);
      console.log(`💰 钱包余额: ${ethers.formatEther(balance)} ETH`);

      if (balance < ethers.parseEther("0.01")) {
        console.log("⚠️  钱包余额较低，可能无法执行交易");
      }

      // 创建 portfolio
      this.portfolio = new Portfolio();
      await this.portfolio.init();

      // 创建 trader
      this.trader = new Trader(
        this.provider,
        this.wallet,
        this.config.contractAddress,
        this.abi,
        this.portfolio
      );

      // 创建监控器
      this.monitor = new ContractMonitor(
        this.provider,
        this.config.contractAddress,
        this.abi,
        this.onNewTokenDetected.bind(this)
      );

      await this.monitor.init();

      console.log("✅ 初始化完成");
      console.log(`📍 监控合约: ${this.config.contractAddress}`);
      console.log(`🎯 目标: 监控 curveIndex=1 的 buyShares 交易`);
      console.log(`💰 自动买入数量: ${this.config.autoBuyAmount || 1}`);
    } catch (error) {
      console.error("❌ 初始化失败:", error);
      process.exit(1);
    }
  }

  validateConfig() {
    const required = ["rpcUrl", "privateKey", "contractAddress"];
    for (const field of required) {
      if (!this.config[field]) {
        throw new Error(`配置文件缺少必要字段: ${field}`);
      }
    }

    // 验证私钥格式
    if (!this.config.privateKey.startsWith("0x")) {
      this.config.privateKey = "0x" + this.config.privateKey;
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
        // multiplier 5 对应 curveIndex 0 和 1，这里使用 0
        return 0;
      default:
        console.log(
          `⚠️  未知的 multiplier 值: ${multiplierValue}，使用默认 curveIndex: 0`
        );
        return 0; // 默认使用 curveIndex 0 (对应 multiplier 5)
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

      // 检查是否启用自动买入
      if (!this.config.autoBuy) {
        console.log("⚠️  自动买入已禁用，跳过买入");
        return;
      }

      // 立即买入，不等待确认以获得最快速度
      console.log("⚡ 立即执行买入，争取最快速度...");

      // 执行自动买入
      const buyAmount = this.config.autoBuyAmount || 1;
      console.log(`🛒 开始自动买入代币，数量: ${buyAmount}`);

      const result = await this.trader.buyToken(
        tokenAddress,
        buyAmount,
        curveIndex
      );

      if (result.success) {
        console.log(`🎊 自动买入成功!`);
        console.log(`   买入交易: ${result.txHash}`);
        console.log(`   Gas 使用: ${result.gasUsed}`);
      } else {
        console.log(`❌ 自动买入失败: ${result.error}`);
      }
    } catch (error) {
      console.error("❌ 处理新代币时出错:", error);
    }
  }

  async start() {
    if (this.isRunning) {
      console.log("⚠️  机器人已在运行中");
      return;
    }

    console.log("\n🤖 启动代币交易机器人...");
    this.isRunning = true;

    // 显示当前持仓
    await this.showPortfolio();

    // 启动监控
    await this.monitor.startMonitoring();

    // 设置优雅退出
    this.setupGracefulShutdown();

    console.log("\n✅ 机器人已启动，按 Ctrl+C 停止");
  }

  async showPortfolio() {
    console.log("\n📊 当前持仓:");
    console.log("=".repeat(50));

    const summary = await this.portfolio.getPortfolioSummary();

    if (Object.keys(summary).length === 0) {
      console.log("📭 暂无持仓");
    } else {
      for (const [tokenAddress, data] of Object.entries(summary)) {
        console.log(`🪙 ${tokenAddress}: ${data.totalAmount} 个`);
      }
    }
  }

  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      console.log(`\n🛑 收到 ${signal} 信号，正在关闭机器人...`);

      if (this.monitor) {
        this.monitor.stopMonitoring();
      }

      this.isRunning = false;
      console.log("✅ 机器人已安全关闭");
      process.exit(0);
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      walletAddress: this.wallet?.address,
      contractAddress: this.config?.contractAddress,
      autoBuy: this.config?.autoBuy,
      autoBuyAmount: this.config?.autoBuyAmount,
      monitor: this.monitor?.getStatus(),
      trader: this.trader?.getStatus(),
    };
  }
}

// 主函数
async function main() {
  const bot = new TokenBot();

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

module.exports = TokenBot;
