#!/usr/bin/env node

const path = require('path');
const SqliteCandidateStore = require('../src/candidatesSqlite');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.split('=');
      const key = k.replace(/^--/, '');
      if (typeof v !== 'undefined') {
        args[key] = v;
      } else {
        // flags like --help or next token as value
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) {
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
  node scripts/candidates_cli.js [--db ./data/candidates.db] [--status pending,bought] [--address 0xabc] [--twitter user] [--limit 50] [--sort createdAt|lastChecked|followers] [--desc]

Examples:
  node scripts/candidates_cli.js --status pending
  node scripts/candidates_cli.js --status bought --limit 10 --desc
  node scripts/candidates_cli.js --twitter mdrafo --status pending,error
  node scripts/candidates_cli.js --address 0x3bb9A --db ./data/candidates.db
`);
}

function formatTs(ts) {
  if (!ts) return '-';
  try { return new Date(Number(ts)).toISOString().replace('T',' ').replace('Z',''); } catch { return String(ts); }
}

(async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { usage(); process.exit(0); }

  const dbPath = args.db || path.join(__dirname, '..', 'data', 'candidates.db');
  const store = new SqliteCandidateStore({ dbPath });
  await store.init();

  let statuses = null;
  if (args.status) {
    statuses = String(args.status)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }

  let rows = store.listCandidates(statuses ? { status: statuses } : {});

  if (args.address) {
    const q = String(args.address).toLowerCase();
    rows = rows.filter(r => (r.address || '').toLowerCase().includes(q));
  }
  if (args.twitter) {
    const q = String(args.twitter).toLowerCase();
    rows = rows.filter(r => (r.creatorTwitter || '').toLowerCase().includes(q));
  }

  const sortKey = args.sort || 'createdAt';
  const desc = !!args.desc;
  rows.sort((a,b) => {
    const va = a[sortKey] ?? 0; const vb = b[sortKey] ?? 0;
    return desc ? (vb - va) : (va - vb);
  });

  const limit = Math.max(1, Number(args.limit || 100));
  if (rows.length > limit) rows = rows.slice(0, limit);

  // Print summary
  const counts = rows.reduce((acc, r) => { acc[r.status] = (acc[r.status]||0)+1; return acc; }, {});
  console.log(`DB: ${dbPath}`);
  console.log(`Total (after filters): ${rows.length} | by status:`, counts);

  // Print rows
  console.log('address                                  status   twitter            followers  blue  createdAt            lastChecked           note');
  console.log('----------------------------------------  -------  -----------------  ---------  ----  -------------------  -------------------  ----');
  for (const r of rows) {
    const addr = (r.address||'').padEnd(40, ' ').slice(0,40);
    const st = (r.status||'').padEnd(7, ' ').slice(0,7);
    const tw = ((r.creatorTwitter||'')+ '               ').slice(0,17);
    const fol = String(r.followers ?? '').padEnd(9, ' ').slice(0,9);
    const blue = r.isBlue ? 'Y' : 'N';
    const created = formatTs(r.createdAt);
    const checked = formatTs(r.lastChecked);
    const note = (r.lastError||'').slice(0,40);
    console.log(`${addr}  ${st}  ${tw}  ${fol}  ${blue}  ${created}  ${checked}  ${note}`);
  }
})();

