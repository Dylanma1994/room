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
        const disp = c.addressChecksum || c.address;
        this.logger.log(`➡️  处理候选: ${disp}`);
        await this.handleCandidate(c);
      } catch (e) {
        const disp = c.addressChecksum || c.address;
        this.logger.warn(`候选处理失败: ${disp}`, e?.message || e);
      }
    }
  }

  async handleCandidate(candidate) {
    const address = candidate.address;
    const checksum = candidate.addressChecksum || address; // 用于 Backroom API
    // 1) 轮询 Backroom API，直到拿到 creatorTwitter
    const room = await this.fetchRoom(checksum);
    if (!room) {
      this.logger.log(`🕓 Backroom：未返回 ${checksum} 的房间数据（继续轮询）`);
      const now = Date.now();
      const createdAt = Number(candidate.createdAt || now);
      const timeoutMinutes = Number(this.config.backroomTimeoutMinutes ?? 5);
      const timeoutMs = Math.max(1, timeoutMinutes) * 60 * 1000;
      if (now - createdAt >= timeoutMs) {
        this.logger.warn(
          `🗑️ Backroom 超时（>${timeoutMinutes} 分钟）未获取到房间信息，删除候选: ${checksum}`
        );
        await this.candidateStore.removeCandidate(address);
        return;
      }
      const currentAttempts = Number(candidate.backroomAttempts || 0) + 1;
      await this.candidateStore.updateCandidate(address, {
        lastChecked: now,
        backroomAttempts: currentAttempts,
      });
      return;
    }
    if (!room.creatorTwitter) {
      this.logger.log(
        `🕓 Backroom：房间数据缺少 creatorTwitter（继续轮询） address=${checksum}`
      );
      const now = Date.now();
      const createdAt = Number(candidate.createdAt || now);
      const timeoutMinutes = Number(this.config.backroomTimeoutMinutes ?? 5);
      const timeoutMs = Math.max(1, timeoutMinutes) * 60 * 1000;
      if (now - createdAt >= timeoutMs) {
        this.logger.warn(
          `🗑️ Backroom 超时（>${timeoutMinutes} 分钟）未获取到 creatorTwitter，删除候选: ${checksum}`
        );
        await this.candidateStore.removeCandidate(address);
        return;
      }
      const currentAttempts = Number(candidate.backroomAttempts || 0) + 1;
      await this.candidateStore.updateCandidate(address, {
        lastChecked: now,
        backroomAttempts: currentAttempts,
      });
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
    const buyAmount = Number(this.config.buyAmountOnCondition ?? 5);

    const passFollowers = followers > followersThreshold;
    const passBlue = !!isBlue;
    const hitReason = passFollowers ? "followers" : passBlue ? "blue" : "none";

    if (passFollowers || passBlue) {
      this.logger.log(
        `✅ 条件满足(任一满足)：粉丝=${followers} (阈值>${followersThreshold}), 蓝V=${isBlue}，命中=${hitReason}，买入 ${buyAmount} 个 ${checksum}`
      );
      // 条件满足时推送通知（可配置）
      await this.notifyConditionMet({
        address: checksum,
        creatorTwitter,
        followers,
        isBlue,
        hitReason,
        buyAmount,
      });
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
        `🗑️ 条件不满足：${creatorTwitter} 粉丝=${followers} (阈值>${followersThreshold}), 蓝V=${isBlue} (要求=${requireBlue})，标记无需买入 ${checksum}`
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

  async notifyConditionMet(payload) {
    try {
      const {
        address,
        creatorTwitter,
        followers,
        isBlue,
        hitReason,
        buyAmount,
      } = payload || {};
      const url =
        this.config.barkEndpoint ||
        "https://dylan-bark-server.onrender.com/dylan";
      const title = `Hit: ${address}`;
      const body = `twitter=${creatorTwitter} followers=${followers} blue=${isBlue} reason=${hitReason} buy=${buyAmount}`;

      const params = {
        title,
        body,
        group: "scanner",
        level: "active",
        isArchive: 1,
        sound: "minuet.caf",
        url: `https://app.backroom.tech/room/${address}`,
      };

      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      }).catch(() => null);
    } catch (_) {
      // 通知失败不影响主流程
    }
  }
}

module.exports = TokenScanner;
