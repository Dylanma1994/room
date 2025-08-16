class TokenScanner {
  constructor({ trader, candidateStore, config, logger = console }) {
    this.trader = trader;
    this.candidateStore = candidateStore;
    this.config = config || {};
    this.logger = logger;
    this.isRunning = false;
    this.timer = null;
    this.intervalMs = Math.max(
      2000,
      Number(this.config.scannerIntervalMs || 5000)
    );
  }

  getStatus() {
    return { isRunning: this.isRunning, intervalMs: this.intervalMs };
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    await this.candidateStore.init();

    const loop = async () => {
      if (!this.isRunning) return;
      try {
        await this.scanOnce();
      } catch (err) {
        this.logger.error("扫描任务异常:", err?.message || err);
      } finally {
        this.timer = setTimeout(loop, this.intervalMs);
      }
    };

    this.logger.log(
      `🔍 启动扫描进程: 每 ${Math.floor(this.intervalMs / 1000)}s 检查候选代币`
    );
    loop();
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async scanOnce() {
    const candidates = await this.candidateStore.listCandidates({
      status: ["pending", "error"],
    });
    if (candidates.length === 0) {
      this.logger.log("🔎 本轮无待处理候选（pending/error）");
      return;
    }

    this.logger.log(`📋 本轮候选数: ${candidates.length}`);

    for (const c of candidates) {
      try {
        this.logger.log(`➡️  处理候选: ${c.address}`);
        await this.handleCandidate(c);
      } catch (e) {
        this.logger.warn(`候选处理失败: ${c.address}`, e?.message || e);
      }
    }
  }

  async handleCandidate(candidate) {
    const address = candidate.address;
    const checksum = candidate.addressChecksum || address; // 用于 Backroom API
    // 1) 轮询 Backroom API，直到拿到 creatorTwitter
    const room = await this.fetchRoom(checksum);
    if (!room) {
      this.logger.log(`🕓 Backroom：未返回 ${address} 的房间数据（继续轮询）`);
      const currentAttempts = Number(candidate.backroomAttempts || 0) + 1;
      await this.candidateStore.updateCandidate(address, {
        lastChecked: Date.now(),
        backroomAttempts: currentAttempts,
      });
      if (currentAttempts >= (this.config.backroomMaxAttempts ?? 10)) {
        this.logger.warn(
          `🗑️ Backroom 超过最大轮询次数(${currentAttempts})，删除候选: ${address}`
        );
        await this.candidateStore.markIgnored(
          address,
          "backroom max attempts reached"
        );
      }
      return;
    }
    if (!room.creatorTwitter) {
      this.logger.log(
        `🕓 Backroom：房间数据缺少 creatorTwitter（继续轮询） address=${address}`
      );
      const currentAttempts = Number(candidate.backroomAttempts || 0) + 1;
      await this.candidateStore.updateCandidate(address, {
        lastChecked: Date.now(),
        backroomAttempts: currentAttempts,
      });
      if (currentAttempts >= (this.config.backroomMaxAttempts ?? 10)) {
        this.logger.warn(
          `🗑️ Backroom 超过最大轮询次数(${currentAttempts})，删除候选: ${address}`
        );
        await this.candidateStore.markIgnored(
          address,
          "backroom max attempts reached"
        );
      }
      return;
    }

    const creatorTwitter = room.creatorTwitter;

    // 2) 请求 Twitter 数据
    const twitter = await this.fetchTwitterUser(creatorTwitter);
    if (!twitter) {
      // 失败，继续轮询
      this.logger.warn(
        `⚠️ Twitter：获取失败（继续轮询） user=${creatorTwitter}`
      );
      await this.candidateStore.updateCandidate(address, {
        lastChecked: Date.now(),
        creatorTwitter,
        status: "error",
        lastError: "twitter fetch failed",
      });
      return;
    }

    const followers = Number(
      twitter.followers ||
        twitter.followersCount ||
        twitter.followers_count ||
        0
    );
    const isBlue = Boolean(
      twitter.isBlueVerified ?? twitter.isVerified ?? twitter.verified ?? false
    );

    // 写回最新评估数据
    await this.candidateStore.updateCandidate(address, {
      lastChecked: Date.now(),
      creatorTwitter,
      followers,
      isBlue,
    });

    // 阈值与买入数量来自配置
    const followersThreshold = Number(
      this.config.twitterFollowersThreshold ?? 10000
    );
    const requireBlue =
      this.config.requireBlueVerification !== undefined
        ? !!this.config.requireBlueVerification
        : true;
    const buyAmount = Number(this.config.buyAmountOnCondition ?? 5);

    const passFollowers = followers > followersThreshold;
    const passBlue = !requireBlue || isBlue;

    if (passFollowers && passBlue) {
      this.logger.log(
        `✅ 条件满足：${creatorTwitter} 粉丝=${followers} (阈值>${followersThreshold}), 蓝V=${isBlue} (要求=${requireBlue})，买入 ${buyAmount} 个 ${address}`
      );
      try {
        const curveIndex = candidate.curveIndex ?? 0;
        const res = await this.trader.buyToken(address, buyAmount, curveIndex);
        if (!res?.success) {
          this.logger.error(`买入失败: ${res?.error || "未知错误"}`);
          await this.candidateStore.updateCandidate(address, {
            status: "error",
            lastChecked: Date.now(),
            lastError: res?.error || "buy failed",
          });
        } else {
          this.logger.log(
            `🟢 已下单：tx=${res.txHash || "?"}, block=${
              res.blockNumber || "?"
            }`
          );
          await this.candidateStore.markBought(address, res.txHash || null);
        }
      } catch (e) {
        this.logger.error(`❌ 买入过程异常: ${e?.message || e}`);
        await this.candidateStore.updateCandidate(address, {
          status: "error",
          lastChecked: Date.now(),
          lastError: e?.message || String(e),
        });
      }
    } else {
      this.logger.log(
        `🗑️ 条件不满足：${creatorTwitter} 粉丝=${followers} (阈值>${followersThreshold}), 蓝V=${isBlue} (要求=${requireBlue})，标记无需买入 ${address}`
      );
      await this.candidateStore.markIgnored(
        address,
        `criteria not met: followers>${followersThreshold} && blueRequired=${requireBlue}`
      );
    }
  }

  async fetchRoom(address) {
    const url = `https://app.backroom.tech/api/rooms/${address}`;
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Referer: `https://app.backroom.tech/room/${address}`,
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      });
      if (!res.ok) {
        return null;
      }
      const data = await res.json().catch(() => null);
      return data || null;
    } catch (e) {
      return null;
    }
  }

  async fetchTwitterUser(userName) {
    const apiKey = this.config.twitterApiKey;
    if (!apiKey) {
      this.logger.warn("未配置 twitterApiKey，无法获取推特数据");
      return null;
    }

    const url = `https://api.twitterapi.io/twitter/user/info?userName=${encodeURIComponent(
      userName
    )}`;
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "X-API-Key": apiKey,
        },
      });
      if (!res.ok) return null;
      const json = await res.json().catch(() => null);
      if (!json || json.status !== "success") return null;
      return json.data || null;
    } catch (e) {
      return null;
    }
  }
}

module.exports = TokenScanner;
