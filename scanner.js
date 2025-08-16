#!/usr/bin/env node

const fs = require('fs-extra');
const SqliteCandidateStore = require('./src/candidatesSqlite');
const TokenScanner = require('./src/scanner');
const { ethers } = require('ethers');
const Portfolio = require('./src/portfolio');
const Trader = require('./src/trader');

async function loadConfig() {
  const file = './config.json';
  if (!(await fs.pathExists(file))) {
    console.log('❌ 配置文件不存在，请先创建 config.json');
    process.exit(1);
  }
  return await fs.readJson(file);
}

async function loadABI() {
  const file = './abi/contract.json';
  if (!(await fs.pathExists(file))) {
    console.log('❌ ABI 文件不存在:', file);
    process.exit(1);
  }
  return await fs.readJson(file);
}

async function main() {
  console.log('🚀 初始化扫描进程...');
  const config = await loadConfig();
  const abi = await loadABI();

  // Provider & Wallet（用于买入）
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const wallet = new ethers.Wallet(config.privateKey, provider);

  // Portfolio & Trader
  const portfolio = new Portfolio();
  await portfolio.init();
  const trader = new Trader(
    provider,
    wallet,
    config.contractAddress,
    abi,
    portfolio,
    config
  );

  // Candidate store
  const store = new SqliteCandidateStore({ dbPath: config.candidateDbPath || './data/candidates.db' });
  await store.init();

  // Scanner
  const scanner = new TokenScanner({
    trader,
    candidateStore: store,
    config,
    logger: console,
  });

  // Start
  console.log('✅ 扫描器初始化完成');
  await scanner.start();
  console.log('🔍 扫描器已启动，按 Ctrl+C 停止');

  // 优雅退出
  const shutdown = async (signal) => {
    console.log(`\n🛑 收到 ${signal} 信号，正在停止扫描器...`);
    scanner.stop();
    console.log('✅ 扫描器已安全停止');
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch((e) => {
    console.error('❌ 扫描器启动失败:', e);
    process.exit(1);
  });
}

