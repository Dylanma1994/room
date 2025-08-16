const fs = require("fs-extra");
const path = require("path");

class CandidateStore {
  constructor(dataDir = "./data") {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, "candidates.json");
    this._initPromise = null;
  }

  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      await fs.ensureDir(this.dataDir);
      if (!(await fs.pathExists(this.file))) {
        await fs.writeJson(this.file, {}, { spaces: 2 });
      }
    })();
    return this._initPromise;
  }

  async _load() {
    try {
      return await fs.readJson(this.file);
    } catch {
      return {};
    }
  }

  async _save(data) {
    // 处理 BigInt 序列化
    const replacer = (key, value) =>
      typeof value === "bigint" ? value.toString() : value;
    await fs.writeJson(this.file, data, { spaces: 2, replacer });
  }

  async addCandidate({
    address,
    curveIndex = 0,
    multiplier = null,
    txHash = null,
    createdAt = Date.now(),
  }) {
    if (!address) throw new Error("address required");
    await this.init();
    const data = await this._load();
    const key = address.toLowerCase();
    if (!data[key]) {
      data[key] = {
        address,
        curveIndex,
        multiplier,
        txHash,
        createdAt,
        lastChecked: 0,
        status: "pending", // pending | bought | ignored | error
        creatorTwitter: null,
        followers: null,
        isBlue: null,
        boughtTxHash: null,
        boughtAt: null,
        ignoredAt: null,
        lastError: null,
      };
      await this._save(data);
    }
    return data[key];
  }

  async removeCandidate(address) {
    await this.init();
    const data = await this._load();
    const key = address.toLowerCase();
    if (data[key]) {
      delete data[key];
      await this._save(data);
      return true;
    }
    return false;
  }

  async updateCandidate(address, patch) {
    await this.init();
    const data = await this._load();
    const key = address.toLowerCase();
    if (!data[key]) return false;
    data[key] = { ...data[key], ...patch };
    await this._save(data);
    return true;
  }

  async listCandidates(filter = {}) {
    await this.init();
    const data = await this._load();
    let arr = Object.values(data);
    if (filter.status) {
      const set = new Set(
        Array.isArray(filter.status) ? filter.status : [filter.status]
      );
      arr = arr.filter((c) => set.has(c.status));
    }
    return arr;
  }

  async markBought(address, boughtTxHash = null) {
    return this.updateCandidate(address, {
      status: "bought",
      boughtTxHash,
      boughtAt: Date.now(),
    });
  }

  async markIgnored(address, reason = null) {
    return this.updateCandidate(address, {
      status: "ignored",
      ignoredAt: Date.now(),
      lastError: reason || null,
    });
  }
}

module.exports = CandidateStore;
