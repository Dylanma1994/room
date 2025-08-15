const fs = require("fs-extra");
const path = require("path");

class Portfolio {
  constructor(dataDir = "./data") {
    this.dataDir = dataDir;
    this.portfolioFile = path.join(dataDir, "portfolio.json");
    this.deferredFile = path.join(dataDir, "deferredSell.json");
    this.init();
  }

  async init() {
    // 确保数据目录存在
    await fs.ensureDir(this.dataDir);

    // 如果持仓文件不存在，创建空的持仓文件
    if (!(await fs.pathExists(this.portfolioFile))) {
      await this.savePortfolio({});
    }

    // 如果延迟卖出文件不存在，创建空文件
    if (!(await fs.pathExists(this.deferredFile))) {
      await fs.writeJson(this.deferredFile, {}, { spaces: 2 });
    }
  }

  async loadPortfolio() {
    try {
      const data = await fs.readJson(this.portfolioFile);
      return data;
    } catch (error) {
      console.error("加载持仓文件失败:", error);
      return {};
    }
  }

  async savePortfolio(portfolio) {
    try {
      await fs.writeJson(this.portfolioFile, portfolio, { spaces: 2 });
    } catch (error) {
      console.error("保存持仓文件失败:", error);
    }
  }

  async addToken(tokenAddress, amount, txHash, timestamp) {
    const portfolio = await this.loadPortfolio();

    if (!portfolio[tokenAddress]) {
      portfolio[tokenAddress] = {
        totalAmount: 0,
        purchases: [],
      };
    }

    portfolio[tokenAddress].totalAmount += amount;
    portfolio[tokenAddress].purchases.push({
      amount,
      txHash,
      timestamp,
      blockNumber: null, // 可以后续添加区块号
    });

    await this.savePortfolio(portfolio);
    console.log(`✅ 添加代币到持仓: ${tokenAddress}, 数量: ${amount}`);
  }

  async removeToken(tokenAddress, amount) {
    const portfolio = await this.loadPortfolio();

    if (!portfolio[tokenAddress]) {
      console.log(`⚠️  代币不在持仓中: ${tokenAddress}`);
      return false;
    }

    if (portfolio[tokenAddress].totalAmount < amount) {
      console.log(
        `⚠️  持仓数量不足: ${tokenAddress}, 持有: ${portfolio[tokenAddress].totalAmount}, 尝试卖出: ${amount}`
      );
      return false;
    }

    portfolio[tokenAddress].totalAmount -= amount;

    // 如果全部卖出，删除该代币记录
    if (portfolio[tokenAddress].totalAmount === 0) {
      delete portfolio[tokenAddress];
      console.log(`✅ 完全卖出代币: ${tokenAddress}`);
    } else {
      console.log(
        `✅ 部分卖出代币: ${tokenAddress}, 剩余: ${portfolio[tokenAddress].totalAmount}`
      );
    }

    await this.savePortfolio(portfolio);
    return true;
  }

  async getTokenAmount(tokenAddress) {
    const portfolio = await this.loadPortfolio();
    return portfolio[tokenAddress]?.totalAmount || 0;
  }

  async getAllTokens() {
    const portfolio = await this.loadPortfolio();
    return Object.keys(portfolio);
  }

  async getPortfolioSummary() {
    const portfolio = await this.loadPortfolio();
    const summary = {};

    for (const [tokenAddress, data] of Object.entries(portfolio)) {
      summary[tokenAddress] = {
        totalAmount: data.totalAmount,
        purchaseCount: data.purchases.length,
        firstPurchase: data.purchases[0]?.timestamp,
        lastPurchase: data.purchases[data.purchases.length - 1]?.timestamp,
      };
    }

    return summary;
  }

  async clearPortfolio() {
    await this.savePortfolio({});
    console.log("✅ 清空持仓记录");
  }

  // 延迟卖出标记相关
  async _loadDeferred() {
    try {
      return await fs.readJson(this.deferredFile);
    } catch {
      return {};
    }
  }

  async markDeferredSell(tokenAddress) {
    const data = await this._loadDeferred();
    data[tokenAddress] = true;
    await fs.writeJson(this.deferredFile, data, { spaces: 2 });
    console.log(`📝 已标记延迟卖出: ${tokenAddress}`);
  }

  async clearDeferredSell(tokenAddress) {
    const data = await this._loadDeferred();
    if (data[tokenAddress]) {
      delete data[tokenAddress];
      await fs.writeJson(this.deferredFile, data, { spaces: 2 });
      console.log(`🧹 已清除延迟卖出标记: ${tokenAddress}`);
    }
  }

  async isDeferredSell(tokenAddress) {
    const data = await this._loadDeferred();
    return !!data[tokenAddress];
  }
}

module.exports = Portfolio;
