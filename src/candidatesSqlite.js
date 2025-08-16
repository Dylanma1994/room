const Database = require("better-sqlite3");
const fs = require("fs-extra");
const path = require("path");
const { ethers } = require("ethers");

class SqliteCandidateStore {
  constructor({ dbPath = "./data/candidates.db" } = {}) {
    this.dbPath = dbPath;
    this.db = null;
  }

  async init() {
    await fs.ensureDir(path.dirname(this.dbPath));
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS candidates (
        address TEXT PRIMARY KEY,             -- 小写主键
        addressChecksum TEXT,                 -- EIP-55 校验格式（原始大小写）
        curveIndex INTEGER,
        multiplier INTEGER,
        txHash TEXT,
        createdAt INTEGER,
        lastChecked INTEGER,
        status TEXT NOT NULL CHECK(status IN ('pending','bought','ignored','error')),
        creatorTwitter TEXT,
        followers INTEGER,
        isBlue INTEGER,
        boughtTxHash TEXT,
        boughtAt INTEGER,
        ignoredAt INTEGER,
        lastError TEXT
      );
    `);
    // 迁移：旧表补充 addressChecksum 列（忽略已存在错误）
    try {
      this.db
        .prepare("ALTER TABLE candidates ADD COLUMN addressChecksum TEXT")
        .run();
    } catch (e) {}
  }

  addCandidate({
    address,
    curveIndex = 0,
    multiplier = null,
    txHash = null,
    createdAt = Date.now(),
  }) {
    if (!address) throw new Error("address required");
    let checksum;
    try {
      checksum = ethers.getAddress(address);
    } catch {
      checksum = address;
    }
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO candidates (address, addressChecksum, curveIndex, multiplier, txHash, createdAt, lastChecked, status)
      VALUES (?, ?, ?, ?, ?, ?, 0, 'pending')
    `);
    stmt.run(
      address.toLowerCase(),
      checksum,
      curveIndex,
      multiplier,
      txHash,
      createdAt
    );
    return this.get(address);
  }

  get(address) {
    const stmt = this.db.prepare("SELECT * FROM candidates WHERE address = ?");
    const row = stmt.get(String(address).toLowerCase());
    if (!row) return null;
    return this._convert(row);
  }

  listCandidates(filter = {}) {
    if (filter.status) {
      const list = Array.isArray(filter.status)
        ? filter.status
        : [filter.status];
      const placeholders = list.map(() => "?").join(",");
      const stmt = this.db.prepare(
        `SELECT * FROM candidates WHERE status IN (${placeholders}) ORDER BY createdAt ASC`
      );
      return stmt.all(...list).map((r) => this._convert(r));
    }
    const stmt = this.db.prepare(
      "SELECT * FROM candidates ORDER BY createdAt ASC"
    );
    return stmt.all().map((r) => this._convert(r));
  }

  updateCandidate(address, patch) {
    const allowed = [
      "curveIndex",
      "multiplier",
      "txHash",
      "createdAt",
      "lastChecked",
      "status",
      "creatorTwitter",
      "followers",
      "isBlue",
      "boughtTxHash",
      "boughtAt",
      "ignoredAt",
      "lastError",
      "addressChecksum",
    ];
    const fields = [];
    const values = [];
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) {
        let v = patch[k];
        // SQLite 绑定类型限制：不接受 boolean，转为 0/1
        if (typeof v === "boolean") v = v ? 1 : 0;
        fields.push(`${k} = ?`);
        values.push(v);
      }
    }
    if (fields.length === 0) return false;
    values.push(String(address).toLowerCase());
    const stmt = this.db.prepare(
      `UPDATE candidates SET ${fields.join(", ")} WHERE address = ?`
    );
    const info = stmt.run(...values);
    return info.changes > 0;
  }

  markBought(address, boughtTxHash = null) {
    const stmt = this.db.prepare(
      `UPDATE candidates SET status='bought', boughtTxHash=?, boughtAt=? WHERE address=?`
    );
    const info = stmt.run(boughtTxHash, Date.now(), address.toLowerCase());
    return info.changes > 0;
  }

  markIgnored(address, reason = null) {
    const stmt = this.db.prepare(
      `UPDATE candidates SET status='ignored', ignoredAt=?, lastError=? WHERE address=?`
    );
    const info = stmt.run(Date.now(), reason, address.toLowerCase());
    return info.changes > 0;
  }

  _convert(row) {
    let checksum = row.addressChecksum;
    if (!checksum && row.address) {
      try {
        checksum = ethers.getAddress(row.address);
      } catch {}
    }
    return {
      address: row.address, // 小写主键
      addressChecksum: checksum || row.address,
      curveIndex: row.curveIndex,
      multiplier: row.multiplier,
      txHash: row.txHash,
      createdAt: row.createdAt,
      lastChecked: row.lastChecked,
      status: row.status,
      creatorTwitter: row.creatorTwitter,
      followers: row.followers,
      isBlue: !!row.isBlue,
      boughtTxHash: row.boughtTxHash,
      boughtAt: row.boughtAt,
      ignoredAt: row.ignoredAt,
      lastError: row.lastError,
    };
  }
}

module.exports = SqliteCandidateStore;
