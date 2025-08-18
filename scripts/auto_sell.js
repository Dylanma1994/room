#!/usr/bin/env node

const fs = require("fs-extra");
const path = require("path");
const { ethers } = require("ethers");
const Trader = require("../src/trader");
const SqliteCandidateStore = require("../src/candidatesSqlite");

// 轻量内存持仓：避免使用 JSON 文件，配合 Trader 的最小方法集合
class MemoryPortfolio {
  constructor() {
    this._deferred = new Set();
    this._balances = new Map(); // addr(lower) -> amount(BigInt or Number)
  }
  async init() {}
  async getTokenAmount(addr) {
    const key = String(addr).toLowerCase();
    const v = this._balances.get(key);
    return v || 0;
  }
  async removeToken(addr, amount) {
    const key = String(addr).toLowerCase();
    const cur = Number(this._balances.get(key) || 0);
    const next = Math.max(0, cur - Number(amount || 0));
    if (next === 0) this._balances.delete(key);
    else this._balances.set(key, next);
    return true;
  }
  async setAmount(addr, amount) {
    const key = String(addr).toLowerCase();
    this._balances.set(key, Number(amount || 0));
  }
  async markDeferredSell(addr) {
    this._deferred.add(String(addr).toLowerCase());
  }
  async clearDeferredSell(addr) {
    this._deferred.delete(String(addr).toLowerCase());
  }
  async isDeferredSell(addr) {
    return this._deferred.has(String(addr).toLowerCase());
  }
}

async function loadConfig() {
  const file = path.join(__dirname, "../config.json");
  if (!(await fs.pathExists(file))) {
    console.log("❌ 配置文件不存在，请先创建 config.json");
    process.exit(1);
  }
  return await fs.readJson(file);
}

async function main() {
  console.log("🚀 启动自动卖出脚本...");
  const config = await loadConfig();

  const holdMinutes = Number(config.autoSellIntervalMinutes || 0);
  if (!holdMinutes || holdMinutes <= 0) {
    console.log("⏱️ 未配置 autoSellIntervalMinutes 或为 0，脚本无需运行");
    process.exit(0);
  }

  // Provider & Wallet（用于卖出）
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const wallet = new ethers.Wallet(config.privateKey, provider);
  console.log(`👛 钱包地址: ${wallet.address}`);

  // Candidates (SQLite) & Trader（使用内存持仓）
  const candidateStore = new SqliteCandidateStore({
    dbPath:
      config.candidateDbPath || path.join(__dirname, "../data/candidates.db"),
  });
  await candidateStore.init();

  const portfolio = new MemoryPortfolio();
  await portfolio.init();

  const trader = new Trader(
    provider,
    wallet,
    config.contractAddress,
    await fs.readJson(path.join(__dirname, "../abi/contract.json")),
    portfolio,
    config
  );

  const holdTimeMs = holdMinutes * 60 * 1000;
  console.log(`⏱️ 自动卖出: 持仓超过 ${holdMinutes} 分钟的代币将被卖出`);

  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      const boughtCandidates = candidateStore.listCandidates({
        status: "bought",
      });

      for (const c of boughtCandidates) {
        const addrLower = c.address; // 小写地址（与 Trader 使用一致）
        const addrDisp = c.addressChecksum || c.address;
        try {
          // 跳过已标记延迟卖出的代币（内存标记，避免频繁重试）
          const deferred = await portfolio.isDeferredSell(addrLower);
          if (deferred) continue;

          // 使用 SQLite 的 boughtAt 判定是否超时
          const boughtAt = Number(c.boughtAt || 0);
          if (!boughtAt) continue;

          const holdTime = now - boughtAt;
          if (holdTime < holdTimeMs) continue;

          // 库中无数量字段，按需求默认 1 个
          const amount = Number(c.amount || 1);
          // 为满足 Trader 的本地检查，将数量写入内存持仓
          await portfolio.setAmount(addrLower, amount);

          const holdMinutesActual = Math.floor(holdTime / 60000);
          console.log(
            `💸 持仓超时卖出: ${addrDisp}, 持仓时间=${holdMinutesActual}分钟, 数量=${amount}`
          );

          const res = await trader.sellToken(addrLower, amount);
          if (res?.success) {
            console.log(
              `✅ 超时卖出成功: ${addrDisp}, tx=${res.txHash || "-"}`
            );
            // 卖出成功后立刻在库中标记忽略，后续不再扫描该代币
            candidateStore.markIgnored(addrLower, "sold by auto_sell");
          } else {
            const msg = String(res?.error || "").toLowerCase();
            console.log(
              `❌ 超时卖出失败: ${addrDisp}, err=${res?.error || "unknown"}`
            );
            if (msg.includes("insufficient shares")) {
              // 标记为忽略，后续不再尝试卖出
              candidateStore.markIgnored(addrLower, "insufficient shares");
              console.log(
                `🛑 检测到 Insufficient shares，已标记忽略后续卖出: ${addrDisp}`
              );
            }
          }
        } catch (err) {
          console.log(
            `❌ 超时卖出处理异常: ${addrDisp}, ${err?.message || err}`
          );
          const msg = String(
            err?.shortMessage || err?.message || err || ""
          ).toLowerCase();
          if (msg.includes("insufficient shares")) {
            // 标记为忽略，后续不再尝试卖出
            candidateStore.markIgnored(addrLower, "insufficient shares");
            console.log(
              `🛑 检测到 Insufficient shares（异常），已标记忽略后续卖出: ${addrDisp}`
            );
          }
        }
      }
    } catch (e) {
      console.log(`❌ 自动卖出任务异常: ${e?.message || e}`);
    } finally {
      running = false;
    }
  }, 1000); // 每秒检查一次
}

if (require.main === module) {
  main().catch((e) => {
    console.error("❌ 脚本异常退出:", e);
    process.exit(1);
  });
}
