const path = require('path');
const fs = require('fs-extra');
const SqliteCandidateStore = require('../src/candidatesSqlite');
const TokenScanner = require('../src/scanner');

class TestScanner extends TokenScanner {
  constructor(opts) {
    super(opts);
    this._map = {
      // address -> {room, twitter}
      '0xroomnull': { room: null, twitter: null },
      '0xnotblue': {
        room: { creatorTwitter: 'user_not_blue' },
        twitter: { followers: 5000, isBlueVerified: false },
      },
      '0xblue': {
        room: { creatorTwitter: 'user_blue' },
        twitter: { followers: 20000, isBlueVerified: true },
      },
    };
  }
  async fetchRoom(address) {
    return this._map[address]?.room || null;
  }
  async fetchTwitterUser(userName) {
    // find by userName mapping
    for (const [addr, v] of Object.entries(this._map)) {
      if (v.room && v.room.creatorTwitter === userName) return v.twitter;
    }
    return null;
  }
}

(async () => {
  const dbPath = path.join(__dirname, '..', 'data', 'test-candidates-smoke.db');
  await fs.remove(dbPath);

  const store = new SqliteCandidateStore({ dbPath });
  await store.init();

  // add candidates
  store.addCandidate({ address: '0xroomnull', curveIndex: 0 });
  store.addCandidate({ address: '0xnotblue', curveIndex: 0 });
  store.addCandidate({ address: '0xblue', curveIndex: 0 });

  const traderMock = {
    async buyToken(address, amount, curveIndex) {
      return { success: true, txHash: '0xtest_' + address.slice(2) };
    },
  };

  const scanner = new TestScanner({
    trader: traderMock,
    candidateStore: store,
    config: { scannerIntervalMs: 1000, twitterApiKey: 'dummy' },
    logger: console,
  });

  // run a single scan loop
  await scanner.scanOnce();

  const all = store.listCandidates();
  console.log('ALL', all);
  console.log('PENDING', store.listCandidates({ status: 'pending' }));
  console.log('IGNORED', store.listCandidates({ status: 'ignored' }));
  console.log('BOUGHT', store.listCandidates({ status: 'bought' }));
})();

