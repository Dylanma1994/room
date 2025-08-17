const { ethers } = require("ethers");
const fs = require("fs-extra");
const ContractMonitor = require("./src/monitor");
const Portfolio = require("./src/portfolio");
const Trader = require("./src/trader");
const TokenScanner = require("./src/scanner");
const SqliteCandidateStore = require("./src/candidatesSqlite");

class TokenBot {
  constructor() {
    this.configFile = "./config.json";
    this.abiFile = "./abi/contract.json";
    this.isRunning = false;
    this.periodicSellTimer = null; // 定时卖出计时器句柄
    this.scanner = null; // 候选扫描器
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

      // 创建交易用 provider：固定使用 HTTP（JsonRpcProvider）
      console.log(`🔌 交易使用 HTTP 连接: ${this.config.rpcUrl}`);
      this.provider = new ethers.JsonRpcProvider(this.config.rpcUrl);

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

      // 候选存储：仅使用 SQLite
      this.candidates = new SqliteCandidateStore({
        dbPath: this.config.candidateDbPath || "./data/candidates.db",
      });
      await this.candidates.init();

      // 创建 trader
      this.trader = new Trader(
        this.provider,
        this.wallet,
        this.config.contractAddress,
        this.abi,
        this.portfolio,
        this.config
      );

      // 创建监控器
      this.monitor = new ContractMonitor(
        this.provider,
        this.config.contractAddress,
        this.abi,
        this.onNewTokenDetected.bind(this),
        this.onExternalBuyDetected.bind(this),
        {
          wsUrl: this.config.wsUrl,
          rpcUrl: this.config.rpcUrl,
          onCreatorSell: this.onCreatorSellDetected.bind(this),
        }
      );

      await this.monitor.init();

      // 启动扫描器
      this.scanner = new TokenScanner({
        trader: this.trader,
        candidateStore: this.candidates,
        config: this.config,
      });

      console.log("✅ 初始化完成");
      console.log(`📍 监控合约: ${this.config.contractAddress}`);
      console.log(`🧪 扫描间隔: ${this.config.scannerIntervalMs || 5000} ms`);
      console.log(
        `🔑 Twitter API Key 已配置: ${this.config.twitterApiKey ? "是" : "否"}`
      );
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
        return 1;
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

      // 新逻辑：不直接买入，加入候选列表供扫描器处理
      await this.candidates.addCandidate({
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

  // 当他人买入我们持有的代币时，自动卖出
  async onExternalBuyDetected({ subject, trader, isBuy }) {
    try {
      if (!isBuy) return;
      if (!this.config.autoSellOnOthersBuy) return; // 开关控制

      // 如果是我们自己买的，不触发
      const selfAddress = this.wallet?.address?.toLowerCase();
      if (
        trader &&
        trader.toLowerCase &&
        trader.toLowerCase() === selfAddress
      ) {
        return;
      }

      // 检查是否持有该代币
      const amount = await this.portfolio.getTokenAmount(subject);
      if (!amount || amount <= 0) return;

      console.log(`\n⚠️ 检测到他人买入我们持有的代币，触发自动卖出`);
      console.log(`   代币: ${subject}`);
      console.log(`   他人地址: ${trader}`);
      console.log(`   我们持有数量: ${amount}`);

      // 卖出全部持仓
      const result = await this.trader.sellToken(subject, amount);
      if (result.success) {
        console.log(`✅ 因他人买入已卖出 ${subject}, tx: ${result.txHash}`);
      } else {
        console.log(`❌ 自动卖出失败: ${result.error}`);
      }
    } catch (error) {
      console.error("❌ 处理外部买入触发卖出时出错:", error);
    }
  }

  // 当创作者卖出时，自动卖出我们持有的该代币
  async onCreatorSellDetected({ subject, trader, txHash, blockNumber }) {
    try {
      if (!this.config.autoSellOnCreatorSell) return;

      // 检查持仓
      const amount = await this.portfolio.getTokenAmount(subject);
      if (!amount || amount <= 0) return;

      console.log(`\n⚠️ 检测到创作者卖出，触发自动卖出`);
      console.log(`   代币: ${subject}`);
      console.log(`   创作者: ${trader}`);
      console.log(`   我们持有数量: ${amount}`);

      const result = await this.trader.sellToken(subject, amount);
      if (result.success) {
        console.log(`✅ 因创作者卖出已卖出 ${subject}, tx: ${result.txHash}`);
      } else {
        console.log(`❌ 创作者卖出触发的自动卖出失败: ${result.error}`);
      }
    } catch (error) {
      console.error("❌ 处理创作者卖出触发卖出时出错:", error);
    }
  }

  async start() {
    if (this.isRunning) {
      console.log("⚠️  机器人已在运行中");
      return;
    }

    if (!this.config.twitterApiKey) {
      console.log("⚠️ 未配置 twitterApiKey，扫描器将无法评估推特条件");
    }

    console.log("\n🤖 启动代币交易机器人...");
    this.isRunning = true;

    // 显示当前持仓
    await this.showPortfolio();

    // 启动监控
    await this.monitor.startMonitoring();

    // 启动扫描器
    if (this.scanner) await this.scanner.start();

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

      if (this.periodicSellTimer) {
        clearInterval(this.periodicSellTimer);
        this.periodicSellTimer = null;
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
