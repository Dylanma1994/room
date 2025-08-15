# 代币交易机器人

一个用于监控和自动交易代币的机器人，专门针对 Base 链上的特定合约。

## 功能特性

- 🔍 **实时监控**: 监控指定合约的 Trade 事件
- 🎯 **智能筛选**: 自动识别新代币创建（supply=1, multiplier=1）
- 🛒 **自动买入**: 检测到新代币时自动买入指定数量
- 💸 **灵活卖出**: 支持单个代币卖出和一键卖出所有持仓
- 📊 **持仓管理**: 自动记录和管理代币持仓信息

## 安装

1. 克隆项目并安装依赖：

```bash
npm install
```

2. 复制配置文件并填写配置：

```bash
cp config.example.json config.json
```

3. 编辑 `config.json` 文件，填入你的配置信息：

```json
{
  "network": "Base Mainnet",
  "rpcUrl": "https://api.zan.top/node/v1/base/mainnet/c3dee4735db145f5aa89e2b5cec1d2bd",
  "wsUrl": "wss://api.zan.top/node/ws/v1/base/mainnet/c3dee4735db145f5aa89e2b5cec1d2bd",
  "contractAddress": "0xbBc7b45150715C06E86964De98562c1171bA408b",
  "privateKey": "你的私钥",
  "autoBuy": true,
  "autoBuyAmount": 1
}
```

**注意**: 配置了 `wsUrl` 时会优先使用 WebSocket 连接以获得最快的事件响应速度。

## 使用方法

### 启动监控机器人

```bash
node index.js
```

机器人将：

- 连接到 Base 网络
- 开始监控指定合约
- 当检测到新代币创建时自动买入
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

## 配置说明

| 字段              | 说明                   | 必填 |
| ----------------- | ---------------------- | ---- |
| `network`         | 网络名称（仅用于显示） | 否   |
| `rpcUrl`          | HTTP RPC 节点地址      | 是   |
| `wsUrl`           | WebSocket 节点地址     | 否   |
| `contractAddress` | 要监控的合约地址       | 是   |
| `privateKey`      | 钱包私钥               | 是   |
| `autoBuy`         | 是否启用自动买入       | 否   |
| `autoBuyAmount`   | 自动买入数量           | 否   |

## 文件结构

```
├── index.js              # 主程序入口
├── sell.js               # 卖出命令工具
├── config.json           # 配置文件（需要创建）
├── config.example.json   # 配置文件示例
├── README.md             # 说明文档
├── abi/
│   └── contract.json     # 合约 ABI 定义
├── src/
│   ├── monitor.js        # 合约监控模块
│   ├── trader.js         # 交易执行模块
│   ├── portfolio.js      # 持仓管理模块
│   └── sellCommand.js    # 卖出命令模块
└── data/
    ├── portfolio.json    # 持仓数据（自动生成）
    ├── lastBlock.json    # 最后处理的区块号（自动生成）
    └── notifications.log # 通知日志（自动生成）
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
