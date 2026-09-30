# Scam or Safe

一个 Solana 交易识别游戏：屏幕上出现一笔钱包弹窗里的交易，30 秒内判断 **Scam** 还是 **Safe**。判错时，识别器解释为什么，指出红旗、怎么看出来、靠哪种证据才看得到。旁边有一个 agent 和你比：它先跑免费启发式，把握不够就在预算内花钱买检查（交易模拟、地址信誉、程序体检、域名核验），预算花光就停下说明。

主体是识别器（`server/detector.js`）和它背后的 edge case 分类表（`data/taxonomy.json`，60 条）。游戏和 agent 都是它的两个用法。

## 跑起来

```bash
npm install
npm start          # http://127.0.0.1:4100
```

另开一个终端让 agent 把全套题跑一遍（需要服务在跑）：

```bash
npm run agent
```

```bash
npm test           # 识别器逐题验证 + 402 收费 + agent 循环
npm run coverage   # 哪些 edge case 有题、哪些待出题
```

键盘：`←`/`s` Scam，`→`/`f` Safe，`a` 让 agent 判断，`Enter` 下一题。

## 结构

```
data/
  taxonomy.json     edge case 分类表（源数据）：60 条，每条 → 规则 + 证据来源 + 答案
  knowledge.json    地址 / 程序 / mint / 域名的“地面事实”，四条付费检查查的就是它
  questions.json    题库：33 题（10 安全 / 23 骗局），每题引用 case
server/
  detector.js       识别器：40 多条规则 → findings / verdict / confidence / 还缺哪种证据；coach() 生成判错解读
  checks.js         四条检查：address / simulate / program / domain
  payment.js        402 收费层（形状照 x402 V2）：mock 方案（无链）和 solana 方案骨架
  knowledge.js      读题库和事实库；知识库没有的域名走启发式（子域名戏法 / 同形字 / 品牌词 / 拼写）
  live.js           devnet 直连骨架（模拟、程序体检、到账核验、转账）—— 未验证
  ledger.js         JSONL 账本
  index.js          Express 入口：静态页 + 游戏 API + 付费路由 + agent 触发
agent/
  loop.js           agent 循环：看题 → 免费启发式 → 买证据 → 重判 → 作答；buy() 处理 402
  budget.js         预算计数器（总额 + 单笔上限）
  payer.js          付款适配器：mock / solana
  cli.js            命令行跑全套题
web/                纯 HTML + JS 页面
docs/edge-cases.md  怎么找 edge case、分类、数据形状、加一条 case 的流程
```

## 付款怎么做

付费路由没有 `X-Payment` 头时返回 402，报价长这样：

```json
{ "x402Version": 2, "error": "payment_required",
  "accepts": [{ "scheme": "mock", "network": "solana:devnet", "asset": "USDC", "price": "0.0200",
                "payTo": "…", "resource": "/check/simulate", "nonce": "…", "maxTimeoutSeconds": 120 }] }
```

- **mock**（默认）：agent 把 `{ nonce, amount, payer }` base64 后放进 `X-Payment`，服务端核对 nonce 未用过、金额够。没有链，一分钟能跑通。
- **solana**：`PAYMENT_SCHEME=solana`，agent 真的在 devnet 转一笔 SOL（`AGENT_KEYPAIR`），签名当 proof，服务端查到账。这条路的四个函数在 `server/live.js`，**还没在 devnet 上跑过**。
- **换成 x402**：卖家侧把 `paywall.charge()` 换成 `@x402/express` + `@x402/svm` 的中间件，agent 侧把 `agent/payer.js` 换成 `@x402/fetch` 的 `wrapFetchWithPayment`；`agent/loop.js` 的 `buy()` 和四条检查不用动。

价格：模拟 $0.02、地址 $0.01、程序 $0.01、域名 $0.005。agent 默认总预算 $0.25、单笔上限 $0.05（`.env.example`）。

## agent 什么时候花钱

`analyze(surface, facts)` 返回 `confidence` 和 `missing`（还缺哪种证据）。置信度低于 0.8 就按信息量从高到低买：模拟 → 地址 → 程序 → 域名，每买一次重跑规则。买之前先过预算，被拒就带着理由停下。几种典型：

| 题 | 免费启发式 | 之后 |
|---|---|---|
| q01 无限授权 | 92% scam | 不花钱 |
| q10 蜜罐币 | 50%，什么都没看出 | 买模拟（正常）→ 体检 MOON mint → permanentDelegate → scam |
| q31 CPI 掏空 | 35%，只知道陌生程序碰了代币账户 | 买模拟：USDC −1000、什么都没进来 → scam |
| q02 正常 swap | 65% safe | 买模拟 / 程序体检拿绿灯 → 95% safe |

## 覆盖情况

60 条 case：45 条有题，10 条待出题，5 条 `depends`（要先定阈值）。`npm run coverage` 打印明细。

## 已知限制

- 题库里的交易是规范化 JSON，不是真的序列化交易。真构造 devnet 交易是下一步。
- 地址 / 程序 / 域名的事实是知识库写死的；`LIVE=1` 只补了程序体检和模拟两条 devnet 路径，未测。
- 识别器是规则引擎，不是模型。它的强项是解释得清楚，弱项是没见过的形状。
- 一切地址除真实程序 ID / 官方 mint 外都是虚构的。
