# Scam 的 edge case：怎么找、怎么分、怎么落成规则和题

这个项目的主体不是游戏，是识别器。识别器的价值取决于它见过多少种骗法，所以 edge case 的清单是源数据（`data/taxonomy.json`），规则（`server/detector.js`）和题库（`data/questions.json`）都对着它来。`npm run coverage` 会告诉你哪些 case 还没有题。

## 找 edge case 的六个方向

1. **表里不一**：弹窗文案 vs 指令语义。按钮叫 Claim / Mint / Verify / Revoke，指令却是 Approve / SetAuthority / Transfer。规则 `label_mismatch`、`stated_amount_mismatch`、`mint_without_mint`。
2. **权限 ≠ 转账**：能拿走钱的远不止 Transfer。Approve（额度）、SetAuthority（所有权 / 关闭权限）、Stake Authorize（withdrawer）、System Assign（整个账户）、AuthorizeNonceAccount、CloseAccount（destination）、优先费（compute budget）、租金（批量建账户）。每一种都是一条规则。
3. **看不见的地方**：CPI 内部的转账 / 授权、Address Lookup Table 里的账户、durable nonce（签了不广播）、非 fee payer 的附签、故意让钱包模拟失败、消息字节其实是交易。这些是「免费看不出，要买证据」的主要来源。
4. **全绿但错**：域名是真的（前端投毒）、程序是真的（参数被改，minOut = 0）、交易是正常的（买到的资产是蜜罐：freeze authority / permanentDelegate / transferHook / 假 mint）。教训是「每一层都只证明它自己那一层」。
5. **假阳性**：正常交易里吓人的词。close / burn / approve / 9 条指令 / 可升级程序 / 模拟失败 / 陌生的 Memo 程序。游戏要有足够多的安全题，识别器要有绿灯规则，否则 agent 会变成「什么都说 scam」。
6. **证据分层**：每条 case 标注需要哪种证据（free / simulation / addresses / programs / domain）。这决定 agent 什么时候该花钱：免费规则已经给出 high 就不买；免费看不出的（蜜罐、CPI、ALT）必须买。

## 分类

| 类 | 主题 | 典型 |
|---|---|---|
| A | 授权与权限 | 无限授权、SetAuthority、质押权限、Token-2022 永久委托 |
| B | 转账与收款方 | 地址投毒、夹带转账、给新地址建 ATA（安全） |
| C | 签名与交易结构 | durable nonce、消息即交易、非 fee payer、ALT、模拟失败、一锅端 |
| D | 程序与合约 | 未验证程序、程序 ID 仿冒、CPI 掏空、官方域名被劫持、参数被改 |
| E | 域名与前端 | 品牌词、同形字、子域名戏法、新域名、官方第二域名（安全） |
| F | 空投 / NFT / 铸造 | 领取即授权、烧 NFT 夹权限、付钱不发货、标价不符 |
| G | 代币与交易 | 假币、蜜罐、滑点为零、复杂但正常的路由（安全） |
| H | 费用与资源 | 优先费掏空、租金掏空 |
| I | 话术与上下文 | 紧迫话术、客服私信 |
| J | 假阳性 | 模拟失败的正常交易、带 memo 的转账、真正的 Revoke |

`truth = depends` 的 case（平台费比例、新域名、增发权限未放弃……）单独出现不定罪，先在规则里定阈值再出题。

## 数据形状

**surface**（弹窗里看得到的）：`domain`、`prompt`、`signMode`（transaction / message）、`feePayer`、`durableNonce`、`addressLookupTables`、`walletSimulation`（ok / failed / unavailable）、`instructions[]`、`message`、`balances`、`addressBook`、`userAccounts`。

**instruction**：`{ program, programLabel, type, label?, accounts: {…}, args: {…} }`。`label` 是 dapp 给的标签（表里不一就靠它）。账户槽位按类型约定：

| type | accounts | args |
|---|---|---|
| Transfer (System) | from, to | lamports, uiAmount, symbol |
| TransferChecked | source, destination, destinationOwner, owner, mint | amount, uiAmount, symbol, decimals |
| Approve / ApproveChecked | source, delegate, owner, mint | amount（u64 字符串）, uiAmount, symbol |
| Revoke | source, owner | |
| SetAuthority | account, currentAuthority, newAuthority | authorityType |
| CloseAccount | account, destination, owner | |
| Authorize (Stake) | stake, authority, newAuthorized | authorityType |
| Assign | account | owner |
| SetComputeUnitLimit / Price | | units / microLamports |
| CreateAssociatedTokenAccount | payer, owner, mint, account | symbol |
| Route / Swap / Deposit（dapp 程序） | userSource, userDestination… | inAmount, inSymbol, minOut, outSymbol, outMint |

ALT 里未解析的账户写成 `{ "lookup": "<table>", "index": n }`。

**facts**（要花钱买的）：`simulation`（sol / tokens 余额变化、delegates、authorities、feeLamports、rent）、`addresses`（reputation：drainer / scam / poisoning / known / program / unknown）、`programs`（程序：verified、upgradeAuthorityKind、lookalikeOf；mint：freezeAuthorityKind、mintAuthorityKind、extensions、impersonates）、`domain`（known / lookalikeOf / lookalikeKind / registeredDaysAgo）。

## 加一条 case 的流程

1. `data/taxonomy.json` 加条目：shows / trick / rules / evidence / truth。
2. `server/detector.js` 加规则（或确认现有规则已覆盖）。规则只做一件事：从 surface + facts 里认出一个信号，给 severity（high / medium / low / green）、标题、解释、怎么看出来、靠哪种证据。
3. `data/questions.json` 出题：surface 里放钱包会显示的，simulation 里放模拟会返回的，地址 / 程序 / 域名的事实放进 `data/knowledge.json`。
4. `npm test`：全事实下 verdict 必须等于 truth；安全题只看 surface 不能出现 high。
5. `npm run coverage` 看还缺什么。

## 还没做的

- 待出题的 case 见 `npm run coverage`（A5、A7、A8、B2、B5、C6、E6、G4、H2、I2）。
- 题库里的交易是规范化 JSON，不是真的序列化交易。下一步是用 `@solana/web3.js` + `@solana/spl-token` 在 devnet 上真构造未签名交易，加一个 `rawBase64` 字段，让 `LIVE=1` 的模拟路由能直接喂给 devnet。
- 域名的 WHOIS / 证书年龄、地址的链上历史，现在都是知识库里写死的数字。
