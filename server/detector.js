// 识别器（主体）。
//
// 输入：surface（钱包弹窗里能看到的一切）+ facts（可选的地面事实：simulation / addresses / programs / domain）。
// 输出：findings（红旗和绿灯，每条带 严重度 / 怎么看出来 / 靠哪种证据）、verdict、confidence、
//       还差哪些证据（missing）。同一套规则被三处调用：
//   1. 服务端教学：玩家答完题后用全部事实跑一遍，解释为什么是 scam / safe；
//   2. agent 循环：先用 facts = {} 跑（免费启发式），再拿买到的检查结果补进 facts 重跑；
//   3. 测试：每道题全事实下 verdict 必须等于 truth，安全题在只有 surface 时不能出现 high。
//
// 规则和 data/taxonomy.json 的 rules 字段一一对应。加一条 edge case 的流程：
//   taxonomy 加条目 → 这里加规则（或复用）→ questions.json 出题 → npm test。

export const IDS = {
  SYSTEM: '11111111111111111111111111111111',
  TOKEN: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  TOKEN22: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ATA: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  CB: 'ComputeBudget111111111111111111111111111111',
  MEMO: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  STAKE: 'Stake11111111111111111111111111111111111111',
  JUP: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  MARINADE: 'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD',
  RAYDIUM: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  ORCA: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  CANDY: 'CndyV3LdqHUfDLmE5naZjVN8rBZz4tqhdefbAnjHG3JR',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  WSOL: 'So11111111111111111111111111111111111111112',
};

// 系统级程序：不算“陌生程序”
export const SYSTEM_PROGRAMS = {
  [IDS.SYSTEM]: 'System', [IDS.TOKEN]: 'SPL Token', [IDS.TOKEN22]: 'Token-2022', [IDS.ATA]: 'Associated Token',
  [IDS.CB]: 'Compute Budget', [IDS.MEMO]: 'Memo', [IDS.STAKE]: 'Stake',
};
// 公共常识：agent 不花钱也知道的官方程序 ID / 官方 mint / 程序 authority。
export const KNOWN_PROGRAMS = {
  [IDS.JUP]: 'Jupiter Aggregator v6', [IDS.MARINADE]: 'Marinade Finance', [IDS.RAYDIUM]: 'Raydium AMM v4',
  [IDS.ORCA]: 'Orca Whirlpool', [IDS.CANDY]: 'Candy Machine v3',
};
export const KNOWN_PROGRAM_AUTHORITIES = { '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1': 'Raydium AMM authority' };
export const KNOWN_MINTS = { USDC: IDS.USDC, wSOL: IDS.WSOL, SOL: IDS.WSOL, mSOL: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' };

export const U64_MAX = '18446744073709551615';
const SEV_WEIGHT = { high: 3, medium: 1.5, low: 0.5, green: -1 };
export const EVIDENCE_PRICES_USD = { simulation: 0.02, addresses: 0.01, programs: 0.01, domain: 0.005 };

const APPROVE = new Set(['Approve', 'ApproveChecked']);
const TRANSFER = new Set(['Transfer', 'TransferChecked']);
const AUTHORITY_CHANGE = new Set(['SetAuthority', 'Authorize', 'AuthorizeNonceAccount']);
const SENSITIVE = new Set([...APPROVE, ...TRANSFER, ...AUTHORITY_CHANGE, 'CloseAccount', 'Assign']);

// ---------- 小工具 ----------
const addr = (x) => (typeof x === 'string' ? x : null);
const isUnresolved = (x) => x && typeof x === 'object' && 'lookup' in x;
const short = (a) => (typeof a === 'string' && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : String(a));
const num = (x) => (typeof x === 'number' ? x : typeof x === 'string' && /^[\d.]+$/.test(x) ? Number(x) : NaN);
const isUnlimited = (args = {}) => args.amount === U64_MAX || args.uiAmount === 'unlimited' || (typeof args.amount === 'string' && /^\d+$/.test(args.amount) && BigInt(args.amount) >= (1n << 63n));

export function promptIntent(prompt = '') {
  const p = prompt.toLowerCase();
  const has = (re) => re.test(p);
  return {
    signin: has(/sign.?in|verify|login|log in|ownership|authenticate|验证|登录|认证/),
    claim: has(/claim|airdrop|reward|领取|空投|奖励/),
    mint: has(/\bmint\b|铸造/),
    swap: has(/swap|兑换|→/),
    transfer: has(/\bsend\b|transfer|转账|发送|充值/),
    stake: has(/stake|质押|migrate|restake/),
    revoke: has(/revoke|撤销/),
    burn: has(/burn|烧/),
    register: has(/register|注册/),
    list: has(/\blist\b|上架|for sale/),
    deposit: has(/deposit|vault|存入/),
    urgency: has(/urgent|immediately|suspend|expire|within \d+ minutes|limited time|last chance|马上|立即|封禁|冻结|过期|最后/),
  };
}

// 文案里出现的金额：“Mint for 0.1 SOL” → [{amount:0.1, symbol:'SOL'}]
export function statedAmounts(prompt = '') {
  const out = [];
  const re = /(\d[\d,]*\.?\d*)\s*(SOL|USDC|USDT|mSOL|RAY)\b/gi;
  let m;
  while ((m = re.exec(prompt))) out.push({ amount: Number(m[1].replace(/,/g, '')), symbol: m[2].toUpperCase() === 'MSOL' ? 'mSOL' : m[2].toUpperCase() });
  return out;
}

function rootDomain(d) {
  const parts = d.split('.');
  return parts.length <= 2 ? d : parts.slice(-2).join('.');
}
const hasNonAscii = (s) => /[^\x00-\x7F]/.test(s);

// ---------- 主分析 ----------
export function analyze(surfaceIn, facts = {}) {
  const surface = { userAccounts: [], addressBook: {}, balances: { sol: 0, tokens: {} }, instructions: [], ...surfaceIn };
  const user = surface.user;
  const self = new Set([user, ...(surface.userAccounts || [])]);
  const isSelf = (a) => typeof a === 'string' && self.has(a);
  const bookAddrs = Object.values(surface.addressBook || {});
  const ixs = surface.instructions || [];
  const intent = promptIntent(surface.prompt);
  const findings = [];
  const add = (rule, severity, title, detail, extra = {}) => findings.push({ rule, severity, title, detail, evidence: 'free', ...extra });

  // 每条指令“钱或权限流向了谁”
  const counterparties = []; // { address, role, ix, type }
  const outflows = [];       // { symbol, amount, to, ix }
  const cp = (address, role, ix) => { if (addr(address) && !isSelf(address)) counterparties.push({ address, role, ix, type: ix.type }); };

  for (const ix of ixs) {
    const a = ix.accounts || {}, g = ix.args || {};
    if (APPROVE.has(ix.type)) cp(a.delegate, 'delegate', ix);
    if (ix.type === 'SetAuthority') cp(a.newAuthority, 'newAuthority', ix);
    if (ix.type === 'Authorize') cp(a.newAuthorized, 'newAuthority', ix);
    if (ix.type === 'AuthorizeNonceAccount') cp(a.newAuthority, 'newAuthority', ix);
    if (ix.type === 'CloseAccount') cp(a.destination, 'closeDestination', ix);
    if (ix.type === 'Assign') cp(g.owner, 'newOwner', ix);
    if (TRANSFER.has(ix.type)) {
      const from = a.from || a.owner || a.authority;
      const to = a.destinationOwner || a.to || a.destination;
      if (isSelf(from) && !isSelf(to)) {
        cp(to, 'recipient', ix);
        outflows.push({ symbol: g.symbol || 'SOL', amount: num(g.uiAmount), to, ix });
      }
    }
  }
  if (surface.feePayer && surface.feePayer !== user) counterparties.push({ address: surface.feePayer, role: 'feePayer', ix: null, type: 'feePayer' });

  const balanceOf = (symbol) => (symbol === 'SOL' ? surface.balances?.sol : surface.balances?.tokens?.[symbol]);

  // ===== 免费规则：只看 surface =====

  // A1 无限授权
  for (const ix of ixs) if (APPROVE.has(ix.type) && isUnlimited(ix.args)) {
    add('unlimited_approve', 'high', '无限授权', `把 ${ix.args?.symbol || '代币'} 的花费权无限额度委托给 ${short(addr(ix.accounts?.delegate) || '未知账户')}。授权不动钱，所以模拟看起来风平浪静，但对方随时能转走全部余额。`, { howToSpot: 'Approve 的数额是 18446744073709551615（u64 最大值）或显示“unlimited”' });
  }
  // A2 / G7：有限授权，看 delegate 是谁
  for (const ix of ixs) if (APPROVE.has(ix.type) && !isUnlimited(ix.args)) {
    const d = ix.accounts?.delegate;
    if (isUnresolved(d)) continue;
    const rep = facts.addresses?.[d];
    const isProgramAuth = KNOWN_PROGRAM_AUTHORITIES[d] || rep?.reputation === 'program';
    if (isProgramAuth) add('bounded_approve_ok', 'green', '有限额度授权给程序', `额度 ${ix.args?.uiAmount} ${ix.args?.symbol}，delegate 是 ${KNOWN_PROGRAM_AUTHORITIES[d] || rep?.label}，这是老式 AMM 的标准写法。`, { howToSpot: '额度等于交易额，delegate 是已知程序的 authority' });
    else if (rep && ['drainer', 'scam', 'poisoning'].includes(rep.reputation)) { /* counterparty_flagged 会报 */ }
    else add('approve_to_wallet', 'medium', '授权给了一个不认识的地址', `额度 ${ix.args?.uiAmount} ${ix.args?.symbol}，delegate ${short(d)} 不是已知程序的 authority。有限额度也能被花光。`, { howToSpot: '把 delegate 和已知程序 authority 列表比对；查地址信誉能确认它是钱包还是程序' });
  }
  // A3-A7 权限转移
  for (const ix of ixs) if (AUTHORITY_CHANGE.has(ix.type)) {
    const to = ix.accounts?.newAuthority || ix.accounts?.newAuthorized;
    if (isSelf(to)) continue;
    const kind = ix.args?.authorityType || (ix.type === 'AuthorizeNonceAccount' ? 'Nonce' : '权限');
    const acct = ix.accounts?.account || ix.accounts?.stake || ix.accounts?.nonce;
    const wsolNote = kind === 'CloseAccount' ? ' 关闭权限意味着对方可以关闭账户并拿走其中的 lamports（wSOL 账户里就是 SOL）。' : kind === 'Withdrawer' ? ' Withdrawer 权限给了谁，质押的 SOL 就是谁的。' : '';
    add('set_authority', 'high', `${kind} 权限转给了别人`, `${short(acct)} 的 ${kind} 权限从你改成 ${short(to)}。${wsolNote}`, { howToSpot: 'SetAuthority / Authorize / AuthorizeNonceAccount 的新权限不是自己' });
  }
  // A5 System Assign
  for (const ix of ixs) if (ix.type === 'Assign' && isSelf(ix.accounts?.account)) {
    add('system_assign', 'high', '钱包账户被分配给程序', `System Assign 把 ${short(ix.accounts.account)} 的 owner 改成 ${short(ix.args?.owner)}，之后只有那个程序能动这个账户。`, { howToSpot: 'System Program 的 Assign 指令，账户是你自己' });
  }
  // B7 / F4 / CloseAccount 去向
  for (const ix of ixs) if (ix.type === 'CloseAccount') {
    const dest = ix.accounts?.destination;
    if (isSelf(dest)) add('close_to_self', 'green', '关闭账户，租金退回自己', `关闭 ${short(ix.accounts.account)}，destination 是你自己：正常的 unwrap / 清理。`, { howToSpot: 'CloseAccount 的 destination 是自己' });
    else add('close_to_stranger', 'high', '关闭账户，余额给了别人', `关闭 ${short(ix.accounts.account)}，里面的 lamports 全部转到 ${short(dest)}。`, { howToSpot: 'CloseAccount 的 destination 不是自己' });
  }
  // J3 Revoke
  {
    const lastRevoke = ixs.map((ix) => ix.type).lastIndexOf('Revoke');
    const approveAfterRevoke = ixs.some((ix, i) => APPROVE.has(ix.type) && i > lastRevoke);
    if (lastRevoke >= 0 && !approveAfterRevoke) {
      add('revoke_is_safe', 'green', '真正的 Revoke', 'Revoke 指令只有 source 和 owner 两个账户，不可能把钱给任何人。', { howToSpot: '指令类型是 Revoke，不是 Approve' });
    }
  }
  // B1 地址投毒
  for (const o of outflows) {
    const to = addr(o.to);
    if (!to || bookAddrs.includes(to)) continue;
    const twin = bookAddrs.find((b) => b !== to && b.slice(0, 4) === to.slice(0, 4) && b.slice(-4) === to.slice(-4));
    if (twin) {
      const name = Object.keys(surface.addressBook).find((k) => surface.addressBook[k] === twin);
      add('address_poisoning', 'high', '地址投毒', `收款地址 ${short(to)} 和通讯录里 ${name}（${short(twin)}）前后 4 位相同、中间不同。这是专门伪造来让你从历史记录复制的。`, { howToSpot: '把整串地址和通讯录逐字比对，不只看前后几位' });
    }
  }
  // I3 通讯录完全一致
  for (const o of outflows) if (bookAddrs.includes(addr(o.to))) {
    const name = Object.keys(surface.addressBook).find((k) => surface.addressBook[k] === o.to);
    add('counterparty_known', 'green', `收款方是通讯录里的 ${name}`, `${short(o.to)} 与通讯录整串一致。`, { howToSpot: '整串地址和通讯录一致' });
  }
  // B3 / F5 / 单独转账：转给非自己、非通讯录的地址
  for (const o of outflows) {
    const to = addr(o.to);
    if (!to || bookAddrs.includes(to)) continue;
    const bal = balanceOf(o.symbol);
    const ratio = bal > 0 && o.amount > 0 ? o.amount / bal : 0;
    const label = o.ix.label ? `（标签“${o.ix.label}”）` : '';
    if (ratio >= 0.5) add('outflow_vs_balance', 'high', `转出 ${o.symbol} 余额的 ${Math.round(ratio * 100)}%`, `${o.amount} ${o.symbol} → ${short(to)}${label}，占你 ${o.symbol} 余额的 ${Math.round(ratio * 100)}%。`, { howToSpot: '把转账金额和自己的余额比一下；“fee”、“verify”不会花掉大半余额' });
    else if (!intent.transfer) add('stray_transfer', 'medium', '夹带的转账', `一笔${intent.swap ? '兑换' : intent.mint ? 'mint' : intent.claim ? '领取' : ''}交易里有一条到 ${short(to)} 的 ${o.amount} ${o.symbol} 转账${label}。网络费不走 Transfer 指令；平台费应该很小且收款方是已知账户。`, { howToSpot: '文案不是转账，指令里却有到陌生地址的 Transfer' });
  }
  // F5 mint 没有 mint 指令
  if (intent.mint && ixs.length && ixs.every((ix) => SYSTEM_PROGRAMS[ix.program]) && outflows.length) {
    add('mint_without_mint', 'medium', 'mint 却没有 mint 指令', '交易里只有系统程序（转账 / memo / compute budget），没有任何 mint 程序调用。付了钱不会有东西发给你。', { howToSpot: '文案说 mint，指令列表里没有 Candy Machine / Token Metadata 之类的程序' });
  }
  // F6 文案金额和交易金额不符
  {
    const stated = statedAmounts(surface.prompt);
    for (const s of stated) {
      const total = outflows.filter((o) => o.symbol === s.symbol).reduce((x, o) => x + (o.amount || 0), 0);
      const swapIn = ixs.filter((ix) => ix.args?.inSymbol === s.symbol).reduce((x, ix) => x + num(ix.args.inAmount), 0);
      const paid = Math.max(total, swapIn);
      if (paid > 0 && paid > s.amount * 1.5 && !(intent.transfer && total === s.amount)) {
        add('stated_amount_mismatch', 'high', '文案金额和交易金额不符', `页面写 ${s.amount} ${s.symbol}，交易里实际是 ${paid} ${s.symbol}。`, { howToSpot: '把文案里的数字和指令里的数字对一下' });
      }
    }
  }
  // C1 durable nonce
  if (surface.durableNonce || ixs.some((ix) => ix.type === 'AdvanceNonceAccount')) {
    if (intent.signin || intent.claim) add('durable_nonce_signin', 'high', 'durable nonce 冒充签名验证', '交易以 AdvanceNonceAccount 开头，签完不会立刻广播，对方可以几天后再发。“验证钱包”只需要签消息，不需要交易，更不需要 durable nonce。', { howToSpot: '第一条指令是 AdvanceNonceAccount，或钱包提示 durable nonce' });
    else add('durable_nonce', 'low', 'durable nonce 交易', '这笔交易不会过期，签了之后对方可以选择时机广播。多签 / 离线签名场景是正常的，普通 dapp 不需要。', { howToSpot: '第一条指令是 AdvanceNonceAccount' });
  }
  // C2 消息其实是交易
  if (surface.signMode === 'message' && surface.message?.looksLikeTransaction) {
    add('message_is_transaction', 'high', '“消息”能反序列化成交易', `要签的字节是一笔合法交易：${surface.message.decoded || ''}。签名就是交易签名。`, { howToSpot: '消息不是可读文本，长度像交易；钱包提示“看起来像交易”' });
  }
  // C7 SIWS
  if (surface.signMode === 'message' && surface.message?.type === 'siws') {
    if (surface.message.domain === surface.domain) add('siws_domain_match', 'green', 'SIWS 明文登录，域名一致', `消息里的 domain ${surface.message.domain} 和页面一致；明文消息签了也上不了链。`, { howToSpot: '明文、有 domain / nonce / issuedAt，域名和页面一致' });
    else add('siws_domain_mismatch', 'high', 'SIWS 消息的域名和页面不一致', `消息里写的是 ${surface.message.domain}，页面是 ${surface.domain}。签名会被拿到另一个站点登录。`, { howToSpot: '对比消息里的 domain 和地址栏' });
  }
  // C3 / C6 不是 fee payer 却在转出
  if (surface.feePayer && surface.feePayer !== user) {
    const touching = ixs.some((ix) => SENSITIVE.has(ix.type) && Object.values(ix.accounts || {}).some(isSelf));
    if (touching) add('not_fee_payer', 'high', '对方付 gas，你的资产在流出', `fee payer 是 ${short(surface.feePayer)}，你只是附签，但指令里动的是你的账户。谁付 gas 不重要，谁签名才重要。`, { howToSpot: 'fee payer 不是自己，而指令的 owner / authority 是自己' });
  }
  // C4 ALT 未解析
  for (const ix of ixs) for (const [role, v] of Object.entries(ix.accounts || {})) if (isUnresolved(v) && ['delegate', 'newAuthority', 'newAuthorized', 'destination', 'destinationOwner', 'to'].includes(role)) {
    add('alt_unresolved', 'medium', `${role} 藏在 Lookup Table 里`, `${ix.type} 的 ${role} 引用了 lookup table ${short(v.lookup)} 第 ${v.index} 项，钱包解析不出来。看不见的那个账户就是整笔交易最重要的东西。`, { howToSpot: '钱包显示“未知账户”或 lookup table 引用；模拟能把它解出来' });
  }
  // C5 模拟失败
  if (surface.walletSimulation && surface.walletSimulation !== 'ok') {
    add('simulation_hidden', 'low', `钱包模拟${surface.walletSimulation === 'failed' ? '失败' : '不可用'}`, '看不见余额变化。单独出现只是“看不见”，不是“有问题”；区块哈希过期也会这样。值得重新模拟一次。', { howToSpot: '钱包提示无法预览变化' });
  }
  // C9 一锅端
  {
    const kinds = new Set(ixs.filter((ix) => SENSITIVE.has(ix.type) && !(TRANSFER.has(ix.type) && isSelf(ix.accounts?.to || ix.accounts?.destinationOwner || ix.accounts?.destination)) && !(ix.type === 'CloseAccount' && isSelf(ix.accounts?.destination))).map((ix) => ix.type.replace('Checked', '')));
    if (kinds.size >= 3) add('mixed_sensitive_ops', 'high', '一笔交易里塞了多种敏感操作', `${[...kinds].join(' + ')} 出现在同一笔交易里，这是 drainer kit 的典型形状。`, { howToSpot: '数一下敏感指令的种类' });
  }
  // F1 / A9 / B5 标签和指令类型不符
  for (const ix of ixs) {
    const label = (ix.label || '').toLowerCase();
    if (!label) continue;
    const expectsReceive = /claim|mint|verify|sign|login|revoke|reward|airdrop|list/.test(label);
    const gives = APPROVE.has(ix.type) || AUTHORITY_CHANGE.has(ix.type) || ix.type === 'Assign' || (ix.type === 'CloseAccount' && !isSelf(ix.accounts?.destination)) || (TRANSFER.has(ix.type) && !isSelf(ix.accounts?.to || ix.accounts?.destinationOwner || ix.accounts?.destination));
    if (expectsReceive && gives && !(label === 'list' && APPROVE.has(ix.type) && KNOWN_PROGRAM_AUTHORITIES[addr(ix.accounts?.delegate)])) {
      add('label_mismatch', 'medium', `按钮叫“${ix.label}”，指令是 ${ix.type}`, `dapp 给这条指令的标签是“${ix.label}”，实际类型是 ${ix.type}：你期待收到东西，指令却在给出权限或资产。`, { howToSpot: '对比 dapp 标签和解码出来的指令类型' });
    }
  }
  // B5 NFT 转出
  for (const o of outflows) if (o.ix.args?.decimals === 0 && o.amount === 1 && !bookAddrs.includes(addr(o.to))) {
    add('nft_outflow', 'high', 'NFT 被转出', `${o.symbol} 转给了 ${short(o.to)}。数量 1 看着无害，实际是一整个 NFT。`, { howToSpot: 'decimals = 0、amount = 1 的 TransferChecked' });
  }
  // H1 优先费
  {
    const units = ixs.find((ix) => ix.type === 'SetComputeUnitLimit')?.args?.units ?? 200000;
    const price = ixs.find((ix) => ix.type === 'SetComputeUnitPrice')?.args?.microLamports ?? 0;
    const feeSol = (units * price) / 1e6 / 1e9;
    if (feeSol >= 0.05) add('priority_fee_excess', 'high', `优先费 ${feeSol} SOL`, `${units.toLocaleString()} CU × ${price.toLocaleString()} microLamports = ${feeSol} SOL，没有任何转账指令也会被烧掉。`, { howToSpot: '看到 SetComputeUnitPrice 就算 units × microLamports ÷ 10^15' });
    else if (feeSol >= 0.005) add('priority_fee_high', 'medium', `优先费偏高：${feeSol} SOL`, '正常优先费在 0.0001 SOL 量级。', { howToSpot: '算一下 units × microLamports' });
  }
  // D2 程序标签冒充已知程序
  for (const ix of ixs) {
    const label = ix.programLabel || '';
    const claimed = Object.entries(KNOWN_PROGRAMS).find(([, name]) => label && name.toLowerCase().startsWith(label.toLowerCase().split(' ')[0]) && label.length > 3);
    if (claimed && claimed[0] !== ix.program && !SYSTEM_PROGRAMS[ix.program]) {
      add('program_label_mismatch', 'high', `标签写 ${label}，程序 ID 不是它`, `${claimed[1]} 的 ID 是 ${short(claimed[0])}，这条指令调用的是 ${short(ix.program)}。前几位一样是故意的。`, { howToSpot: '程序 ID 整串比对，不看前缀' });
    }
  }
  // G1 符号冒充官方 mint
  for (const ix of ixs) {
    const sym = ix.args?.symbol || ix.args?.outSymbol;
    const mint = ix.accounts?.mint || ix.args?.outMint;
    if (sym && mint && KNOWN_MINTS[sym] && KNOWN_MINTS[sym] !== mint && (ix.type === 'CreateAssociatedTokenAccount' || ix.args?.outMint)) {
      add('symbol_mint_mismatch', 'high', `“${sym}”不是官方的 ${sym}`, `收到的 mint 是 ${short(mint)}，官方 ${sym} 的 mint 是 ${short(KNOWN_MINTS[sym])}。符号可以随便叫。`, { howToSpot: '收到的代币 mint 和官方 mint 整串比对' });
    }
  }
  // D6 / G5 滑点为零
  for (const ix of ixs) if (ix.args && 'minOut' in ix.args && num(ix.args.minOut) === 0 && num(ix.args.inAmount) > 0) {
    add('zero_min_out', 'high', '最小收到数量是 0', `${ix.args.inAmount} ${ix.args.inSymbol} 换 ${ix.args.outSymbol}，minOut = 0：拿到 0 也算成功，三明治机器人会吃掉大半。程序和域名都对时，这是被篡改的前端或插件。`, { howToSpot: '看 swap 指令的 minOut / slippage 参数' });
  }
  // D4 陌生程序拿到了你的代币账户
  for (const ix of ixs) if (!SYSTEM_PROGRAMS[ix.program] && !KNOWN_PROGRAMS[ix.program]) {
    const touches = Object.values(ix.accounts || {}).filter((v) => typeof v === 'string' && isSelf(v) && v !== user);
    if (touches.length && !facts.programs?.[ix.program]) add('unknown_program_touches_assets', 'medium', '陌生程序拿到了你的代币账户', `${ix.programLabel || short(ix.program)}（${short(ix.program)}）不在已知程序列表里，账户列表里有你的 ${touches.map(short).join('、')}。程序内部可以对这些账户做任何你签过名的事。`, { howToSpot: '程序 ID 不认识 + 账户里有自己的代币账户；模拟和程序体检能说清' });
  }
  // E2 / E3 域名免费能看的
  if (surface.domain) {
    if (hasNonAscii(surface.domain)) add('domain_non_ascii', 'high', '域名里有非 ASCII 字符', `“${surface.domain}” 含有非 ASCII 字符（同形异义字），肉眼看不出来。`, { howToSpot: '程序检查域名字符集；人只能靠书签' });
    const root = rootDomain(surface.domain);
    const brands = ['jup.ag', 'raydium.io', 'marinade.finance', 'drift.trade', 'magiceden.io', 'phantom.app', 'orca.so', 'tensor.trade'];
    const embedded = brands.find((b) => surface.domain !== b && !surface.domain.endsWith('.' + b) && surface.domain.includes(b));
    if (embedded) add('domain_subdomain_trick', 'high', '官方域名只是子域名的一部分', `“${surface.domain}” 的根域名是 ${root}，${embedded} 只是前面的字符。`, { howToSpot: '域名从右往左读，倒数第二段才是真正的主人' });
  }
  // I1 话术
  if (intent.urgency) add('urgency_language', 'low', '紧迫话术', '“马上 / 冻结 / 10 分钟内”这类文案是弱信号，单独不定罪，但正规项目不会这样催你签名。', { howToSpot: '文案里有时限和威胁' });

  // ===== 需要地面事实的规则 =====
  const sim = facts.simulation;
  if (sim) {
    if (sim.ok === false) add('sim_failed', 'low', '模拟执行失败', `模拟返回错误：${sim.error || '未知'}。`, { evidence: 'simulation' });
    // hidden_outflow / pay_without_receive
    const inflow = (sim.tokens || []).filter((t) => t.delta > 0).length + (sim.sol?.delta > 0 ? 1 : 0);
    const outs = [...(sim.tokens || []).filter((t) => t.delta < 0).map((t) => ({ symbol: t.symbol, amount: -t.delta, pre: t.pre })), ...(sim.sol?.delta < -0.01 ? [{ symbol: 'SOL', amount: -sim.sol.delta, pre: sim.sol.pre }] : [])];
    for (const o of outs) {
      const ratio = o.pre > 0 ? o.amount / o.pre : 0;
      const shownAmount = outflows.filter((x) => x.symbol === o.symbol).reduce((s, x) => s + (x.amount || 0), 0) + ixs.filter((ix) => ix.args?.inSymbol === o.symbol).reduce((s, ix) => s + num(ix.args.inAmount), 0) + ixs.filter((ix) => ix.type === 'BurnChecked' && ix.args?.symbol === o.symbol).reduce((s, ix) => s + num(ix.args.uiAmount), 0);
      const hidden = o.amount > shownAmount * 1.05 + 0.01;
      if (hidden && (ratio >= 0.3 || o.amount >= 1)) add('hidden_outflow', 'high', `模拟显示 ${o.symbol} 少了 ${o.amount}，弹窗里没有对应指令`, `指令列表里能看到的 ${o.symbol} 支出是 ${shownAmount}，模拟里实际流出 ${o.amount}（余额的 ${Math.round(ratio * 100)}%）。差额发生在程序内部（CPI）或费用里。${sim.notes ? '模拟备注：' + sim.notes : ''}`, { evidence: 'simulation', howToSpot: '模拟的余额变化和指令列表对不上' });
      else if (ratio >= 0.5 && !intent.transfer && !intent.swap && !intent.stake && !intent.deposit) add('outflow_vs_balance', 'high', `模拟显示 ${o.symbol} 流出余额的 ${Math.round(ratio * 100)}%`, `${o.amount} ${o.symbol} 流出，而文案是“${surface.prompt}”。`, { evidence: 'simulation', howToSpot: '模拟的余额变化' });
    }
    if ((intent.mint || intent.claim || intent.deposit || intent.swap) && outs.length && inflow === 0 && !ixs.some((ix) => ix.type === 'OrderUnstake' || ix.type === 'CreateAccount')) {
      add('pay_without_receive', 'high', '只出不进', `模拟里 ${outs.map((o) => `${o.amount} ${o.symbol}`).join('、')} 流出，没有任何资产流入。${intent.mint ? 'mint 应该有 NFT 进来' : intent.swap ? '兑换应该有目标代币进来' : intent.deposit ? '存款应该有份额凭证进来' : '领取应该有东西进来'}。`, { evidence: 'simulation', howToSpot: '模拟的流入列表为空' });
    }
    for (const d of sim.delegates || []) {
      const shown = ixs.some((ix) => APPROVE.has(ix.type) && addr(ix.accounts?.delegate) === d.delegate);
      const isProg = KNOWN_PROGRAM_AUTHORITIES[d.delegate] || facts.addresses?.[d.delegate]?.reputation === 'program';
      if (!isProg && !shown) add('delegate_granted_sim', 'high', `模拟显示 ${d.symbol} 被委托给 ${short(d.delegate)}`, `额度 ${d.amount}。这个委托在弹窗里看不到（藏在 CPI 或 lookup table 里），模拟把它解出来了。`, { evidence: 'simulation', howToSpot: '模拟后代币账户的 delegate 字段变了' });
    }
    for (const a of sim.authorities || []) {
      const shown = ixs.some((ix) => AUTHORITY_CHANGE.has(ix.type) && addr(ix.accounts?.newAuthority || ix.accounts?.newAuthorized) === a.to);
      if (!isSelf(a.to) && !shown) add('authority_changed_sim', 'high', `模拟显示 ${short(a.account)} 的 ${a.type} 权限变成了 ${short(a.to)}`, '弹窗里没有对应的 SetAuthority，权限变化发生在程序内部。', { evidence: 'simulation', howToSpot: '模拟后账户的 authority 字段变了' });
    }
    if (sim.feeLamports && sim.feeLamports / 1e9 >= 0.05 && !findings.some((f) => f.rule === 'priority_fee_excess')) add('priority_fee_excess', 'high', `模拟显示手续费 ${sim.feeLamports / 1e9} SOL`, '费用来自 compute budget 的优先费。', { evidence: 'simulation' });
    if (sim.rent?.lamports >= 0.5e9) add('rent_outflow', 'high', `租金流出 ${sim.rent.lamports / 1e9} SOL`, `创建了 ${sim.rent.created} 个账户，租金归 ${short(sim.rent.closableBy)} 可关闭的账户。`, { evidence: 'simulation' });
  }

  // 地址信誉
  if (facts.addresses) {
    const seen = new Set();
    const list = [...counterparties.map((c) => ({ address: c.address, role: c.role })), ...(sim?.delegates || []).map((d) => ({ address: d.delegate, role: 'delegate' })), ...(sim?.authorities || []).map((a) => ({ address: a.to, role: 'newAuthority' }))];
    for (const c of list) {
      const rep = facts.addresses[c.address];
      if (!rep || seen.has(c.address)) continue;
      seen.add(c.address);
      const roleZh = { delegate: '委托对象', newAuthority: '新权限持有人', closeDestination: '关闭账户的收款方', recipient: '收款方', feePayer: 'fee payer', newOwner: '新 owner' }[c.role] || c.role;
      if (['drainer', 'scam', 'poisoning'].includes(rep.reputation)) add('counterparty_flagged', 'high', `${roleZh}是已标记地址：${rep.label || rep.reputation}`, `${short(c.address)}：${rep.notes || ''}`, { evidence: 'addresses', howToSpot: '查地址信誉' });
      else if (rep.reputation === 'known') add('counterparty_known', 'green', `${roleZh}是已知地址：${rep.label}`, `${short(c.address)}：${rep.notes || ''}`, { evidence: 'addresses' });
      else if (rep.reputation === 'program') add('counterparty_program', 'green', `${roleZh}是程序账户：${rep.label}`, rep.notes || '', { evidence: 'addresses' });
      else if (rep.reputation === 'unknown' && rep.firstSeenDaysAgo != null && rep.firstSeenDaysAgo <= 3 && c.role !== 'feePayer') add('counterparty_fresh', 'medium', `${roleZh}是 ${rep.firstSeenDaysAgo} 天前才出现的地址`, `${short(c.address)} 没有历史。`, { evidence: 'addresses' });
    }
  }

  // 程序 / mint 体检
  if (facts.programs) {
    for (const ix of ixs) {
      if (SYSTEM_PROGRAMS[ix.program]) continue;
      const p = facts.programs[ix.program];
      if (!p || p.kind !== 'program') continue;
      if (p.lookalikeOf) add('program_lookalike', 'high', `程序 ID 仿冒 ${KNOWN_PROGRAMS[p.lookalikeOf] || short(p.lookalikeOf)}`, `${short(ix.program)} 未验证、${p.deployedDaysAgo} 天前部署、升级权限是热钱包 ${short(p.upgradeAuthority)}。`, { evidence: 'programs' });
      else if (!p.verified) add('unverified_program', p.upgradeAuthorityKind === 'hot-wallet' && p.deployedDaysAgo <= 30 ? 'high' : 'medium', `未验证程序：${p.name}`, `${short(ix.program)} 未验证构建，${p.deployedDaysAgo} 天前部署，升级权限是${p.upgradeAuthorityKind === 'hot-wallet' ? '热钱包 ' + short(p.upgradeAuthority) : p.upgradeAuthorityKind}。程序内容随时可以换。`, { evidence: 'programs' });
      else add('verified_program', 'green', `已验证程序：${p.name}`, `${p.upgradeable ? `可升级，升级权限是${p.upgradeAuthorityKind === 'multisig' ? '多签' : p.upgradeAuthorityKind}` : '不可升级'}，部署 ${p.deployedDaysAgo} 天。可升级不是红旗，升级权限是热钱包才是。`, { evidence: 'programs' });
    }
    // 收到的 mint
    const received = new Set();
    for (const ix of ixs) { if (ix.type === 'CreateAssociatedTokenAccount' && isSelf(ix.accounts?.owner)) received.add(ix.accounts.mint); if (ix.args?.outMint) received.add(ix.args.outMint); }
    for (const t of sim?.tokens || []) if (t.delta > 0) received.add(t.mint);
    for (const mint of received) {
      const m = facts.programs[mint];
      if (!m || m.kind !== 'mint') continue;
      if (m.impersonates) add('fake_mint', 'high', `收到的“${m.symbol}”是假币`, `${short(mint)} 冒充 ${short(m.impersonates)}，${m.ageDays} 天前创建，${m.holders} 个持有者。`, { evidence: 'programs' });
      const traps = [];
      if ((m.extensions || []).includes('permanentDelegate')) traps.push('permanentDelegate（发行方随时可划走）');
      if ((m.extensions || []).includes('transferHook')) traps.push('transferHook（hook 程序可拒绝转出）');
      if (m.freezeAuthorityKind === 'hot-wallet') traps.push('冻结权限是热钱包（可冻住你的账户）');
      if (m.mintAuthorityKind === 'hot-wallet') traps.push('增发权限是热钱包');
      if (traps.length) add('honeypot_mint', traps.some((t) => /permanentDelegate|transferHook|冻结/.test(t)) ? 'high' : 'medium', `资产陷阱：${m.symbol}`, `交易本身正常，买到的代币有：${traps.join('；')}。${m.ageDays != null ? `mint ${m.ageDays} 天前创建` : ''}${m.notes ? '。' + m.notes : ''}`, { evidence: 'programs', howToSpot: '查 mint 的 freeze / mint authority 和 Token-2022 扩展' });
    }
  }

  // 域名核验
  if (facts.domain && surface.domain) {
    const d = facts.domain;
    if (d.known) add('domain_known', 'green', `域名属于 ${d.officialOf}`, `${surface.domain} 注册 ${d.registeredDaysAgo} 天。注意：域名对 ≠ 交易对，前端可以被投毒。`, { evidence: 'domain' });
    else if (d.lookalikeOf) add('domain_lookalike', 'high', `域名仿冒 ${d.lookalikeOf}`, `${surface.domain}（${{ brand: '品牌词', typo: '拼写', homoglyph: '同形异义字', subdomain: '子域名' }[d.lookalikeKind] || d.lookalikeKind}），注册 ${d.registeredDaysAgo} 天。${d.notes || ''}`, { evidence: 'domain' });
    else if (d.registeredDaysAgo != null && d.registeredDaysAgo <= 30) add('domain_fresh', 'medium', `域名 ${d.registeredDaysAgo} 天前注册`, `${surface.domain} 没有历史。`, { evidence: 'domain' });
    else add('domain_unknown', 'low', '域名不在已知列表', `${surface.domain} 既不是已知官方域名，也没有仿冒迹象。`, { evidence: 'domain' });
  }

  // ===== 汇总 =====
  const count = (s) => findings.filter((f) => f.severity === s).length;
  const H = count('high'), M = count('medium'), L = count('low'), G = count('green');
  const score = findings.reduce((s, f) => s + SEV_WEIGHT[f.severity], 0);
  let verdict, confidence;
  if (H > 0) { verdict = 'scam'; confidence = Math.min(0.98, 0.9 + 0.02 * H); }
  else if (score >= 2.5) { verdict = 'scam'; confidence = Math.min(0.85, 0.6 + 0.1 * (M - 2)); }
  else { verdict = 'safe'; confidence = Math.max(0.3, Math.min(0.95, 0.5 + 0.15 * G - 0.15 * M - 0.05 * L)); }

  // 还差哪些证据（agent 决定要不要花钱买）
  const missing = [];
  const hasTx = surface.signMode !== 'message' || surface.message?.looksLikeTransaction;
  if (hasTx && !facts.simulation) missing.push({ kind: 'simulation', reason: '看不到程序内部的余额 / 权限变化' });
  const cpAddrs = [...new Set([...counterparties.map((c) => c.address), ...(sim?.delegates || []).map((d) => d.delegate), ...(sim?.authorities || []).map((a) => a.to)])].filter((a) => !KNOWN_PROGRAM_AUTHORITIES[a] && !facts.addresses?.[a]);
  if (cpAddrs.length) missing.push({ kind: 'addresses', reason: `不知道 ${cpAddrs.map(short).join('、')} 是谁`, targets: cpAddrs });
  const progs = [...new Set([...ixs.filter((ix) => !SYSTEM_PROGRAMS[ix.program]).map((ix) => ix.program), ...ixs.filter((ix) => ix.type === 'CreateAssociatedTokenAccount' && isSelf(ix.accounts?.owner)).map((ix) => ix.accounts.mint), ...ixs.map((ix) => ix.args?.outMint).filter(Boolean), ...(sim?.tokens || []).filter((t) => t.delta > 0).map((t) => t.mint)])].filter((p) => !facts.programs?.[p]);
  if (progs.length) missing.push({ kind: 'programs', reason: `没有体检 ${progs.map((p) => KNOWN_PROGRAMS[p] || short(p)).join('、')}`, targets: progs });
  if (surface.domain && !facts.domain) missing.push({ kind: 'domain', reason: `没有核验 ${surface.domain}` });

  return { verdict, confidence: Number(confidence.toFixed(2)), score, findings, counts: { high: H, medium: M, low: L, green: G }, missing, counterparties };
}

// ---------- 判错后的解读 ----------
export function coach(question, analysis, answer) {
  const truth = question.truth;
  const correct = answer === truth;
  const reds = analysis.findings.filter((f) => f.severity === 'high' || f.severity === 'medium');
  const lows = analysis.findings.filter((f) => f.severity === 'low');
  const greens = analysis.findings.filter((f) => f.severity === 'green');
  const ev = (f) => ({ free: '弹窗里就能看到', simulation: '要买模拟才能看到', addresses: '要查地址信誉才能看到', programs: '要做程序体检才能看到', domain: '要核验域名才能看到' }[f.evidence] || f.evidence);
  const item = (f) => ({ severity: f.severity, title: f.title, detail: f.detail, howToSpot: f.howToSpot || null, evidence: ev(f) });
  let headline, sections = [];
  if (!correct && truth === 'scam') {
    headline = answer === 'timeout' ? '超时了，这是一个骗局' : '你放行了一个骗局';
    sections.push({ title: '红旗', items: reds.map(item) });
    if (greens.length) sections.push({ title: '为什么它看起来像正常交易', items: greens.map(item) });
  } else if (!correct && truth === 'safe') {
    headline = answer === 'timeout' ? '超时了，这其实是一笔正常交易' : '你拒绝了一笔正常交易';
    const scary = [...reds, ...lows];
    if (scary.length) sections.push({ title: '让你警觉的点，以及为什么它们不成立', items: scary.map(item) });
    else sections.push({ title: '让你警觉的点', items: [{ severity: 'low', title: '识别器没有找到任何红旗', detail: '可能是指令数量、陌生的程序名或“close / burn / approve”这类词让人紧张。', howToSpot: null, evidence: '弹窗里就能看到' }] });
    sections.push({ title: '它安全的依据', items: greens.map(item) });
  } else if (truth === 'scam') {
    headline = '判断正确，这是一个骗局';
    sections.push({ title: '红旗', items: reds.map(item) });
  } else {
    headline = '判断正确，这是一笔正常交易';
    sections.push({ title: '它安全的依据', items: greens.map(item) });
    if (reds.length || lows.length) sections.push({ title: '容易被误读的点', items: [...reds, ...lows].map(item) });
  }
  return { correct, truth, answer, headline, sections, lesson: question.lesson, cases: question.case };
}
