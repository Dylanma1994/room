#!/usr/bin/env node

const path = require("path");
const SqliteCandidateStore = require("../src/candidatesSqlite");

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.split("=");
      const key = k.replace(/^--/, "");
      if (typeof v !== "undefined") {
        args[key] = v;
      } else {
        // flags like --help or next token as value
        const next = argv[i + 1];
        if (!next || next.startsWith("--")) {
          args[key] = true;
        } else {
          args[key] = next;
          i++;
        }
      }
    }
  }
  return args;
}

function usage() {
  console.log(`
Candidates CLI (SQLite)

Usage:
  node scripts/candidates_cli.js [--db ./data/candidates.db] [--status pending,bought] [--address 0xabc] [--twitter user] [--limit 50] [--sort createdAt|lastChecked|followers] [--desc] [--no-limit]
  node scripts/candidates_cli.js --scan-dbs [--dir ./data]                    # 扫描目录下的所有 .db 并汇总状态
  node scripts/candidates_cli.js --clear --db ./data/candidates.db --yes       # 清空当前数据库 candidates 表
  node scripts/candidates_cli.js --dump --db ./data/candidates.db              # 原始 JSON 导出

Examples:
  node scripts/candidates_cli.js --status pending
  node scripts/candidates_cli.js --status bought --limit 10 --desc
  node scripts/candidates_cli.js --twitter mdrafo --status pending,error
  node scripts/candidates_cli.js --address 0x3bb9A --db ./data/candidates.db
  node scripts/candidates_cli.js --scan-dbs --dir ./data
  node scripts/candidates_cli.js --clear --db ./data/candidates.db --yes
`);
}

function formatTs(ts) {
  if (!ts) return "-";
  try {
    return new Date(Number(ts))
      .toISOString()
      .replace("T", " ")
      .replace("Z", "");
  } catch {
    return String(ts);
  }
}

(async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    process.exit(0);
  }

  const dbPath = args.db || path.join(__dirname, "..", "data", "candidates.db");

  if (args.clear) {
    if (!args.db) {
      console.log("❌ 执行清空操作必须指定 --db");
      process.exit(1);
    }
    if (!args.yes) {
      console.log("⚠️ 将清空数据库中的 candidates 表。若确认，请附加 --yes");
      process.exit(1);
    }
    const DB = require("better-sqlite3");
    const db = new DB(dbPath);
    db.exec("DELETE FROM candidates; VACUUM;");
    console.log(`✅ 已清空 candidates 表: ${dbPath}`);
    process.exit(0);
  }

  if (args["scan-dbs"]) {
    const dir = args.dir || path.join(__dirname, "..", "data");
    const fs = require("fs");
    const DB = require("better-sqlite3");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".db"));
    if (files.length === 0) {
      console.log(`目录无 .db 文件: ${dir}`);
      process.exit(0);
    }
    console.log(`扫描目录: ${dir}`);
    for (const f of files) {
      const p = path.join(dir, f);
      try {
        const db = new DB(p);
        const rows = db
          .prepare(
            "SELECT status, COUNT(*) as cnt FROM candidates GROUP BY status"
          )
          .all();
        console.log(`DB: ${p}`);
        console.table(rows);
      } catch (e) {
        console.log(`DB: ${p} 无法读取: ${e.message}`);
      }
    }
    process.exit(0);
  }

  const store = new SqliteCandidateStore({ dbPath });
  await store.init();

  let statuses = null;
  if (args.status) {
    statuses = String(args.status)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  let rows = store.listCandidates(statuses ? { status: statuses } : {});

  if (args.address) {
    const q = String(args.address).toLowerCase();
    rows = rows.filter((r) => (r.address || "").toLowerCase().includes(q));
  }
  if (args.twitter) {
    const q = String(args.twitter).toLowerCase();
    rows = rows.filter((r) =>
      (r.creatorTwitter || "").toLowerCase().includes(q)
    );
  }

  const sortKey = args.sort || "createdAt";
  const desc = !!args.desc;
  rows.sort((a, b) => {
    const va = a[sortKey] ?? 0;
    const vb = b[sortKey] ?? 0;
    return desc ? vb - va : va - vb;
  });

  const limit = Math.max(1, Number(args.limit || 100));
  if (rows.length > limit) rows = rows.slice(0, limit);

  // Print summary
  const counts = rows.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  console.log(`DB: ${dbPath}`);
  console.log(`Total (after filters): ${rows.length} | by status:`, counts);

  // Print rows
  console.log(
    "address                                  status   twitter            followers  blue  createdAt            lastChecked           note"
  );
  console.log(
    "----------------------------------------  -------  -----------------  ---------  ----  -------------------  -------------------  ----"
  );
  // 改为展示所有字段表格
  const rowsOut = rows.map((r) => ({
    addressChecksum: r.addressChecksum || r.address || "",
    address: r.address || "",
    status: r.status || "",
    creatorTwitter: r.creatorTwitter || "",
    followers: r.followers ?? null,
    isBlue: !!r.isBlue,
    curveIndex: r.curveIndex ?? null,
    multiplier: r.multiplier ?? null,
    txHash: r.txHash || "",
    boughtTxHash: r.boughtTxHash || "",
    createdAt: formatTs(r.createdAt),
    lastChecked: formatTs(r.lastChecked),
    boughtAt: formatTs(r.boughtAt),
    ignoredAt: formatTs(r.ignoredAt),
    lastError: r.lastError || "",
  }));
  console.table(rowsOut);
})();
