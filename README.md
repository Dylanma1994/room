# 代币交易机器人

一个用于监控和自动交易代币的机器人，专门针对 Base 链上的特定合约。

## 功能特性

- 🔍 **实时监控**: 监控指定合约的 Trade 事件
- 🎯 **智能识别**: 自动识别新代币创建（supply=1）
- 📝 **候选入库**: 新盘不直接买入，先入库候选（支持 JSON 或 SQLite 持久化）
- 🤖 **扫描评估**: 扫描器调用 Backroom + Twitter，粉丝 > 1 万且蓝 V 时自动买入 5 个
- 💸 **灵活卖出**: 支持单个代币卖出和一键卖出所有持仓
- 📊 **持仓管理**: 自动记录和管理代币持仓信息
- 🛠️ **CLI 工具**: 提供候选状态查询/筛选脚本

## 安装

1. 克隆项目并安装依赖：

```bash
npm install
```

2. 创建并编辑 `config.json` 文件，填入你的配置信息（示例）：

```json
{
  "network": "Base Mainnet",
  "rpcUrl": "https://your-rpc",
  "wsUrl": "wss://your-ws",
  "contractAddress": "0xbBc7b45150715C06E86964De98562c1171bA408b",
  "privateKey": "你的私钥(0x...)",

  "candidateStore": "sqlite",
  "candidateDbPath": "./data/candidates.db",

  "twitterApiKey": "你的 Twitter API Key",
  "scannerIntervalMs": 5000,

  "autoSellOnOthersBuy": true,
  "autoSellIntervalMinutes": 3,

  "usePendingNonce": true,
  "buyGasLimit": 250000,
  "gasBoostMultiplier": 1.3,
  "gasTipGwei": 2
}
```

> 说明：旧的 `autoBuy`/`autoBuyAmount` 已不再生效（兼容保留），新逻辑由扫描器基于 Twitter 条件决定是否买入。

**注意**: 配置了 `wsUrl` 时会优先使用 WebSocket 连接以获得最快的事件响应速度。

## 使用方法

### 启动监控机器人

```bash
node index.js
```

机器人将：

- 连接到 Base 网络
- 开始监控指定合约
- 检测到新代币创建时，将代币信息入库（候选）
- 扫描器轮询 Backroom 与 Twitter，满足条件（粉丝>1w 且蓝 V）时自动买入 5 个
- 显示实时日志信息

### 卖出代币

查看当前持仓：

```bash
node sell.js portfolio
# 或简写
node sell.js p
```

卖出指定代币：

```bash
node sell.js sell 0x代币地址
# 卖出指定数量
node sell.js sell 0x代币地址 10
```

一键卖出所有代币：

```bash
node sell.js sellall
# 或简写
node sell.js sa
```

查看帮助：

```bash
node sell.js help
```

## 配置说明（关键字段）

| 字段                      | 说明                                   | 必填 |
| ------------------------- | -------------------------------------- | ---- |
| `network`                 | 网络名称（仅用于显示）                 | 否   |
| `rpcUrl`                  | HTTP RPC 节点地址                      | 是   |
| `wsUrl`                   | WebSocket 节点地址                     | 否   |
| `contractAddress`         | 要监控的合约地址                       | 是   |
| `privateKey`              | 钱包私钥                               | 是   |
| `candidateStore`          | 候选存储方式：`sqlite` 或留空使用 JSON | 否   |
| `candidateDbPath`         | SQLite 数据库路径（`sqlite` 时生效）   | 否   |
| `twitterApiKey`           | Twitter API Key（扫描器评估必须）      | 是   |
| `scannerIntervalMs`       | 扫描器单轮间隔（毫秒），默认 5000      | 否   |
| `autoSellOnOthersBuy`     | 当他人买入我们持有代币时是否自动卖出   | 否   |
| `autoSellIntervalMinutes` | 周期性卖出全部持仓的间隔（分钟）       | 否   |
| `usePendingNonce`         | 使用 pending nonce                     | 否   |
| `buyGasLimit`             | 买入交易 gasLimit                      | 否   |
| `gasBoostMultiplier`      | EIP-1559 费率提升倍数                  | 否   |
| `gasTipGwei`              | 指定 tip（gwei），为空则按当前网络计算 | 否   |

## 文件结构

```
├── index.js               # 主程序入口
├── sell.js                # 卖出命令工具
├── config.json            # 配置文件（需要创建）
├── README.md              # 说明文档
├── abi/
│   └── contract.json      # 合约 ABI 定义
├── src/
│   ├── monitor.js         # 合约监控模块
│   ├── trader.js          # 交易执行模块
│   ├── portfolio.js       # 持仓管理模块
│   ├── candidates.js      # 候选存储(JSON)
│   ├── candidatesSqlite.js# 候选存储(SQLite)
│   └── sellCommand.js     # 卖出命令模块
├── scripts/
│   ├── candidates_cli.js  # 候选状态 CLI（SQLite）
│   └── smoke_scanner.js   # 扫描器冒烟测试
└── data/
    ├── portfolio.json     # 持仓数据（自动生成）
    ├── lastBlock.json     # 最后处理的区块号（自动生成）
    └── candidates.db      # 候选 SQLite 数据库（自动生成）
```

## 工作原理

1. **监控阶段**：

   - 连接到 Base 网络的 RPC 节点
   - 监听合约的 Trade 事件
   - 筛选新代币创建事件（supply=1, multiplier=1）

2. **买入阶段**：

   - 当检测到新代币创建时，自动买入
   - 调用 `buyShares` 方法买入代币（`amount=1`, `curveIndex=0`）
   - 将买入记录保存到持仓文件

3. **卖出阶段**：
   - 通过命令行工具查看持仓
   - 调用 `sellShares` 方法卖出指定数量的代币
   - 更新持仓记录

## 安全提示

⚠️ **重要安全提醒**：

1. **私钥安全**：

   - 不要将包含真实私钥的 `config.json` 提交到版本控制
   - 建议使用专门的交易钱包，不要使用主钱包
   - 定期检查钱包余额和交易记录

2. **资金管理**：

   - 建议先在测试网测试
   - 不要投入超过你能承受损失的资金
   - 定期检查和备份持仓数据

3. **网络安全**：
   - 使用可信的 RPC 节点
   - 注意网络延迟对交易时机的影响

## 故障排除

### 常见问题

1. **连接失败**：

   - 检查 RPC URL 是否正确
   - 确认网络连接正常

2. **交易失败**：

   - 检查钱包余额是否足够
   - 确认 Gas 设置是否合理
   - 查看交易失败的具体原因

3. **监控中断**：
   - 程序会自动从上次停止的区块继续
   - 检查 `data/lastBlock.json` 文件

### CLI：候选状态查询（SQLite）

- 帮助
  - `node scripts/candidates_cli.js --help`
- 常用示例
  - `node scripts/candidates_cli.js --status pending`
  - `node scripts/candidates_cli.js --status bought --limit 10 --desc`
  - `node scripts/candidates_cli.js --twitter mdrafo --status pending,error`
  - `node scripts/candidates_cli.js --address 0x3bb9A --db ./data/candidates.db`

### 日志说明

- `✅` 成功操作
- `❌` 失败操作
- `⚠️` 警告信息
- `🔍` 监控信息
- `🛒` 买入操作
- `💸` 卖出操作

## 许可证

MIT License

## 免责声明

本软件仅供学习和研究使用。使用本软件进行交易的所有风险由用户自行承担。开发者不对任何损失负责。
