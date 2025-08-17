#!/usr/bin/env node

const fs = require("fs-extra");
const path = require("path");
const { ethers } = require("ethers");
const Portfolio = require("../src/portfolio");
const Trader = require("../src/trader");

async function loadConfig() {
  const file = path.join(__dirname, "../config.json");
  if (!(await fs.pathExists(file))) {
    console.log("❌ 配置文件不存在，请先创建 config.json");
    process.exit(1);
  }
  return await fs.readJson(file);
}

async function main() {
  console.log("🚀 启动定时卖出脚本...");
  const config = await loadConfig();

  const minutes = Number(config.autoSellIntervalMinutes || 0);
  if (!minutes || minutes <= 0) {
    console.log("⏱️ 未配置 autoSellIntervalMinutes 或为 0，脚本无需运行");
    process.exit(0);
  }

  // Provider & Wallet（用于卖出）
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const wallet = new ethers.Wallet(config.privateKey, provider);
  console.log(`👛 钱包地址: ${wallet.address}`);

  // Portfolio & Trader
  const portfolio = new Portfolio();
  await portfolio.init();
  const trader = new Trader(
    provider,
    wallet,
    config.contractAddress,
    // 这里不需要 ABI，Trader 构造函数会使用 provider+wallet 直接 create contract
    // 但我们项目内的 Trader 构造函数签名需要 abi，沿用 index.js 的方式
    // 为保持一致，我们复用 index.js 中加载的 ABI 文件
    // 简单起见在此处加载 abi 文件
    await fs.readJson(path.join(__dirname, "../abi/contract.json")),
    portfolio,
    config
  );

  const intervalMs = Math.max(60_000, Math.floor(minutes * 60 * 1000));
  console.log(`⏱️ 定时卖出: 每 ${minutes} 分钟执行一次`);

  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const tokens = await portfolio.getAllTokens();
      if (!tokens || tokens.length === 0) {
        return;
      }

      for (const token of tokens) {
        try {
          const deferred = await portfolio.isDeferredSell(token);
          if (deferred) {
            console.log(`⏭️ 跳过延迟卖出: ${token}`);
            continue;
          }
          const amount = await portfolio.getTokenAmount(token);
          if (!amount || amount <= 0) continue;
          console.log(`💸 定时卖出: ${token}, 数量=${amount}`);
          const res = await trader.sellToken(token, amount);
          if (res?.success) {
            console.log(`✅ 定时卖出成功: ${token}, tx=${res.txHash || "-"}`);
          } else {
            console.log(`❌ 定时卖出失败: ${token}, err=${res?.error || "unknown"}`);
          }
        } catch (err) {
          console.log(`❌ 定时卖出处理异常: ${token}, ${err?.message || err}`);
        }
      }
    } catch (e) {
      console.log(`❌ 定时卖出任务异常: ${e?.message || e}`);
    } finally {
      running = false;
    }
  }, intervalMs);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("❌ 脚本异常退出:", e);
    process.exit(1);
  });
}

