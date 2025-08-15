const { ethers } = require('ethers');
const fs = require('fs-extra');
const path = require('path');
const Portfolio = require('./portfolio');
const Trader = require('./trader');

class SellCommand {
  constructor() {
    this.configFile = './config.json';
    this.abiFile = './abi/contract.json';
  }

  async loadConfig() {
    if (!await fs.pathExists(this.configFile)) {
      throw new Error(`配置文件不存在: ${this.configFile}`);
    }
    return await fs.readJson(this.configFile);
  }

  async loadABI() {
    if (!await fs.pathExists(this.abiFile)) {
      throw new Error(`ABI 文件不存在: ${this.abiFile}`);
    }
    return await fs.readJson(this.abiFile);
  }

  async init() {
    try {
      // 加载配置
      this.config = await this.loadConfig();
      this.abi = await this.loadABI();

      // 创建 provider
      this.provider = new ethers.JsonRpcProvider(this.config.rpcUrl);

      // 创建 wallet
      this.wallet = new ethers.Wallet(this.config.privateKey, this.provider);

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

      console.log(`✅ 初始化完成`);
      console.log(`   钱包地址: ${this.wallet.address}`);
      console.log(`   合约地址: ${this.config.contractAddress}`);
      console.log(`   网络: ${this.config.network || 'Unknown'}`);

    } catch (error) {
      console.error('❌ 初始化失败:', error.message);
      throw error;
    }
  }

  async showPortfolio() {
    console.log('\n📊 当前持仓:');
    console.log('='.repeat(50));
    
    const summary = await this.portfolio.getPortfolioSummary();
    
    if (Object.keys(summary).length === 0) {
      console.log('📭 暂无持仓');
      return;
    }

    for (const [tokenAddress, data] of Object.entries(summary)) {
      console.log(`🪙 代币: ${tokenAddress}`);
      console.log(`   数量: ${data.totalAmount}`);
      console.log(`   购买次数: ${data.purchaseCount}`);
      console.log(`   首次购买: ${new Date(data.firstPurchase).toLocaleString()}`);
      console.log(`   最后购买: ${new Date(data.lastPurchase).toLocaleString()}`);
      console.log('');
    }
  }

  async sellToken(tokenAddress, amount = null) {
    console.log(`\n💸 开始卖出代币: ${tokenAddress}`);
    
    if (amount) {
      console.log(`   指定数量: ${amount}`);
    } else {
      console.log(`   卖出全部持仓`);
    }

    const result = await this.trader.sellToken(tokenAddress, amount);
    
    if (result.success) {
      console.log(`\n🎉 卖出成功!`);
      console.log(`   交易哈希: ${result.txHash}`);
      console.log(`   区块号: ${result.blockNumber}`);
      console.log(`   Gas 使用: ${result.gasUsed}`);
    } else {
      console.log(`\n❌ 卖出失败: ${result.error}`);
    }

    return result;
  }

  async sellAllTokens() {
    console.log(`\n🔄 开始卖出所有代币`);
    
    const tokens = await this.portfolio.getAllTokens();
    
    if (tokens.length === 0) {
      console.log('📭 没有持仓代币');
      return [];
    }

    console.log(`   共有 ${tokens.length} 个代币需要卖出`);
    
    const results = await this.trader.sellAllTokens();
    
    console.log(`\n📊 卖出结果汇总:`);
    console.log('='.repeat(50));
    
    let successCount = 0;
    let failCount = 0;
    
    for (const result of results) {
      if (result.success) {
        successCount++;
        console.log(`✅ ${result.tokenAddress}: 成功 (${result.txHash})`);
      } else {
        failCount++;
        console.log(`❌ ${result.tokenAddress}: 失败 (${result.error})`);
      }
    }
    
    console.log(`\n📈 总计: ${successCount} 成功, ${failCount} 失败`);
    
    return results;
  }

  async run(command, ...args) {
    try {
      await this.init();

      switch (command) {
        case 'portfolio':
        case 'p':
          await this.showPortfolio();
          break;

        case 'sell':
        case 's':
          if (args.length === 0) {
            console.log('❌ 请提供代币地址');
            console.log('用法: node sell.js sell <代币地址> [数量]');
            return;
          }
          const tokenAddress = args[0];
          const amount = args[1] ? parseInt(args[1]) : null;
          await this.sellToken(tokenAddress, amount);
          break;

        case 'sellall':
        case 'sa':
          await this.sellAllTokens();
          break;

        case 'help':
        case 'h':
        default:
          this.showHelp();
          break;
      }

    } catch (error) {
      console.error('❌ 执行失败:', error.message);
      process.exit(1);
    }
  }

  showHelp() {
    console.log(`
🛠️  卖出工具使用说明:

命令:
  portfolio, p           显示当前持仓
  sell <地址> [数量]      卖出指定代币 (不指定数量则卖出全部)
  sellall, sa           卖出所有持仓代币
  help, h               显示帮助信息

示例:
  node sell.js portfolio
  node sell.js sell 0x1234...abcd
  node sell.js sell 0x1234...abcd 10
  node sell.js sellall

配置文件: config.json
持仓文件: data/portfolio.json
    `);
  }
}

// 如果直接运行此文件
if (require.main === module) {
  const sellCommand = new SellCommand();
  const [,, command, ...args] = process.argv;
  sellCommand.run(command || 'help', ...args);
}

module.exports = SellCommand;
