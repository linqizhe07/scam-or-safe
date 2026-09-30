// The detector (the core).
//
// Input: surface (everything visible in the wallet popup) + facts (optional ground truth: simulation / addresses / programs / domain).
// Output: findings (red flags and green lights, each with a severity / how to spot it / which evidence it needs), verdict, confidence,
//         and which evidence is still missing. The same rule set is called from three places:
//   1. Server-side coaching: after the player answers, run with all facts to explain why it is a scam / safe;
//   2. The agent loop: first run with facts = {} (free heuristics), then fold the purchased check results into facts and rerun;
//   3. Tests: every question's verdict under full facts must equal truth, and a safe question must never produce a high from the surface alone.
//
// Rules map one-to-one to the rules field in data/taxonomy.json. To add an edge case:
//   add a taxonomy entry → add a rule here (or reuse one) → write a question in questions.json → npm test.

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

// System-level programs: never counted as "unknown programs"
export const SYSTEM_PROGRAMS = {
  [IDS.SYSTEM]: 'System', [IDS.TOKEN]: 'SPL Token', [IDS.TOKEN22]: 'Token-2022', [IDS.ATA]: 'Associated Token',
  [IDS.CB]: 'Compute Budget', [IDS.MEMO]: 'Memo', [IDS.STAKE]: 'Stake',
};
// Public knowledge: official program IDs / official mints / program authorities the agent knows without spending anything.
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

// ---------- Helpers ----------
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

// Amounts stated in the prompt: "Mint for 0.1 SOL" → [{amount:0.1, symbol:'SOL'}]
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

// ---------- Main analysis ----------
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

  // Where each instruction's money or authority goes
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

  // ===== Free rules: surface only =====

  // A1 unlimited approve
  for (const ix of ixs) if (APPROVE.has(ix.type) && isUnlimited(ix.args)) {
    add('unlimited_approve', 'high', 'Unlimited approval', `Delegates unlimited spending of ${ix.args?.symbol || 'the token'} to ${short(addr(ix.accounts?.delegate) || 'an unknown account')}. An approval moves no funds, so the simulation looks calm, but the delegate can drain the whole balance at any time.`, { howToSpot: 'The Approve amount is 18446744073709551615 (u64 max) or shows as "unlimited"' });
  }
  // A2 / G7: bounded approve, depends on who the delegate is
  for (const ix of ixs) if (APPROVE.has(ix.type) && !isUnlimited(ix.args)) {
    const d = ix.accounts?.delegate;
    if (isUnresolved(d)) continue;
    const rep = facts.addresses?.[d];
    const isProgramAuth = KNOWN_PROGRAM_AUTHORITIES[d] || rep?.reputation === 'program';
    if (isProgramAuth) add('bounded_approve_ok', 'green', 'Bounded approval to a program', `Allowance ${ix.args?.uiAmount} ${ix.args?.symbol}; the delegate is ${KNOWN_PROGRAM_AUTHORITIES[d] || rep?.label}, the standard pattern for older AMMs.`, { howToSpot: 'The allowance equals the trade amount and the delegate is a known program authority' });
    else if (rep && ['drainer', 'scam', 'poisoning'].includes(rep.reputation)) { /* reported by counterparty_flagged */ }
    else add('approve_to_wallet', 'medium', 'Approval to an unrecognized address', `Allowance ${ix.args?.uiAmount} ${ix.args?.symbol}; delegate ${short(d)} is not a known program authority. A bounded allowance can still be spent in full.`, { howToSpot: 'Compare the delegate against the known program authority list; an address reputation check tells a wallet from a program' });
  }
  // A3-A7 authority transfers
  for (const ix of ixs) if (AUTHORITY_CHANGE.has(ix.type)) {
    const to = ix.accounts?.newAuthority || ix.accounts?.newAuthorized;
    if (isSelf(to)) continue;
    const kind = ix.args?.authorityType || (ix.type === 'AuthorizeNonceAccount' ? 'Nonce' : 'Account');
    const acct = ix.accounts?.account || ix.accounts?.stake || ix.accounts?.nonce;
    const wsolNote = kind === 'CloseAccount' ? ' Close authority means they can close the account and take its lamports (in a wSOL account, that is SOL).' : kind === 'Withdrawer' ? ' Whoever holds the Withdrawer authority owns the staked SOL.' : '';
    add('set_authority', 'high', `${kind} authority handed to someone else`, `The ${kind} authority of ${short(acct)} changes from you to ${short(to)}.${wsolNote}`, { howToSpot: 'The new authority in SetAuthority / Authorize / AuthorizeNonceAccount is not you' });
  }
  // A5 System Assign
  for (const ix of ixs) if (ix.type === 'Assign' && isSelf(ix.accounts?.account)) {
    add('system_assign', 'high', 'Wallet account assigned to a program', `System Assign changes the owner of ${short(ix.accounts.account)} to ${short(ix.args?.owner)}; afterwards only that program can touch the account.`, { howToSpot: 'A System Program Assign instruction whose account is your own' });
  }
  // B7 / F4 / CloseAccount destination
  for (const ix of ixs) if (ix.type === 'CloseAccount') {
    const dest = ix.accounts?.destination;
    if (isSelf(dest)) add('close_to_self', 'green', 'Close account, rent refunded to you', `Closes ${short(ix.accounts.account)} with the destination set to you: a normal unwrap / cleanup.`, { howToSpot: 'The CloseAccount destination is you' });
    else add('close_to_stranger', 'high', 'Close account, balance sent to someone else', `Closes ${short(ix.accounts.account)}; all of its lamports go to ${short(dest)}.`, { howToSpot: 'The CloseAccount destination is not you' });
  }
  // J3 Revoke
  {
    const lastRevoke = ixs.map((ix) => ix.type).lastIndexOf('Revoke');
    const approveAfterRevoke = ixs.some((ix, i) => APPROVE.has(ix.type) && i > lastRevoke);
    if (lastRevoke >= 0 && !approveAfterRevoke) {
      add('revoke_is_safe', 'green', 'A genuine Revoke', 'A Revoke instruction has only two accounts, source and owner; it cannot give funds to anyone.', { howToSpot: 'The instruction type is Revoke, not Approve' });
    }
  }
  // B1 address poisoning
  for (const o of outflows) {
    const to = addr(o.to);
    if (!to || bookAddrs.includes(to)) continue;
    const twin = bookAddrs.find((b) => b !== to && b.slice(0, 4) === to.slice(0, 4) && b.slice(-4) === to.slice(-4));
    if (twin) {
      const name = Object.keys(surface.addressBook).find((k) => surface.addressBook[k] === twin);
      add('address_poisoning', 'high', 'Address poisoning', `Recipient ${short(to)} shares its first and last 4 characters with ${name} (${short(twin)}) in your address book but differs in the middle. It was forged so you would copy it from your history.`, { howToSpot: 'Compare the full address against the address book character by character, not just the ends' });
    }
  }
  // I3 exact address-book match
  for (const o of outflows) if (bookAddrs.includes(addr(o.to))) {
    const name = Object.keys(surface.addressBook).find((k) => surface.addressBook[k] === o.to);
    add('counterparty_known', 'green', `Recipient is ${name} from your address book`, `${short(o.to)} matches the address book entry in full.`, { howToSpot: 'The full address matches the address book' });
  }
  // B3 / F5 / standalone transfer: to an address that is neither you nor in the address book
  for (const o of outflows) {
    const to = addr(o.to);
    if (!to || bookAddrs.includes(to)) continue;
    const bal = balanceOf(o.symbol);
    const ratio = bal > 0 && o.amount > 0 ? o.amount / bal : 0;
    const label = o.ix.label ? ` (label "${o.ix.label}")` : '';
    if (ratio >= 0.5) add('outflow_vs_balance', 'high', `Sends ${Math.round(ratio * 100)}% of your ${o.symbol} balance`, `${o.amount} ${o.symbol} → ${short(to)}${label}, ${Math.round(ratio * 100)}% of your ${o.symbol} balance.`, { howToSpot: 'Compare the transfer amount with your balance; a "fee" or "verify" never costs most of it' });
    else if (!intent.transfer) add('stray_transfer', 'medium', 'Bundled transfer', `A${intent.swap ? ' swap' : intent.mint ? ' mint' : intent.claim ? ' claim' : ''} transaction contains a ${o.amount} ${o.symbol} transfer to ${short(to)}${label}. Network fees do not use a Transfer instruction; a platform fee should be small and go to a known account.`, { howToSpot: 'The prompt is not a transfer, yet the instructions include a Transfer to an unfamiliar address' });
  }
  // F5 mint without a mint instruction
  if (intent.mint && ixs.length && ixs.every((ix) => SYSTEM_PROGRAMS[ix.program]) && outflows.length) {
    add('mint_without_mint', 'medium', 'Says mint, but there is no mint instruction', 'The transaction contains only system programs (transfer / memo / compute budget) and no call to any mint program. You pay and nothing is sent to you.', { howToSpot: 'The prompt says mint, but the instruction list has no Candy Machine / Token Metadata program' });
  }
  // F6 stated amount vs transaction amount
  {
    const stated = statedAmounts(surface.prompt);
    for (const s of stated) {
      const total = outflows.filter((o) => o.symbol === s.symbol).reduce((x, o) => x + (o.amount || 0), 0);
      const swapIn = ixs.filter((ix) => ix.args?.inSymbol === s.symbol).reduce((x, ix) => x + num(ix.args.inAmount), 0);
      const paid = Math.max(total, swapIn);
      if (paid > 0 && paid > s.amount * 1.5 && !(intent.transfer && total === s.amount)) {
        add('stated_amount_mismatch', 'high', 'Stated amount differs from the transaction', `The page says ${s.amount} ${s.symbol}; the transaction actually moves ${paid} ${s.symbol}.`, { howToSpot: 'Compare the number in the prompt with the number in the instructions' });
      }
    }
  }
  // C1 durable nonce
  if (surface.durableNonce || ixs.some((ix) => ix.type === 'AdvanceNonceAccount')) {
    if (intent.signin || intent.claim) add('durable_nonce_signin', 'high', 'Durable nonce posing as a sign-in', 'The transaction starts with AdvanceNonceAccount, so it is not broadcast right after signing; the other side can send it days later. "Verifying a wallet" only needs a signed message, not a transaction, let alone a durable nonce.', { howToSpot: 'The first instruction is AdvanceNonceAccount, or the wallet warns about a durable nonce' });
    else add('durable_nonce', 'low', 'Durable nonce transaction', 'This transaction never expires; once signed, the other side chooses when to broadcast it. Normal for multisig / offline signing, unnecessary for an ordinary dapp.', { howToSpot: 'The first instruction is AdvanceNonceAccount' });
  }
  // C2 the message is really a transaction
  if (surface.signMode === 'message' && surface.message?.looksLikeTransaction) {
    add('message_is_transaction', 'high', 'The "message" deserializes into a transaction', `The bytes to sign form a valid transaction: ${surface.message.decoded || ''}. The signature is a transaction signature.`, { howToSpot: 'The message is not readable text and is transaction-sized; the wallet warns "looks like a transaction"' });
  }
  // C7 SIWS
  if (surface.signMode === 'message' && surface.message?.type === 'siws') {
    if (surface.message.domain === surface.domain) add('siws_domain_match', 'green', 'Plaintext SIWS sign-in, domain matches', `The domain in the message, ${surface.message.domain}, matches the page; a signed plaintext message can never land on chain.`, { howToSpot: 'Plaintext with domain / nonce / issuedAt, and the domain matches the page' });
    else add('siws_domain_mismatch', 'high', 'SIWS message domain does not match the page', `The message says ${surface.message.domain}; the page is ${surface.domain}. The signature will be used to log in on another site.`, { howToSpot: 'Compare the domain in the message with the address bar' });
  }
  // C3 / C6 not the fee payer, yet assets flow out
  if (surface.feePayer && surface.feePayer !== user) {
    const touching = ixs.some((ix) => SENSITIVE.has(ix.type) && Object.values(ix.accounts || {}).some(isSelf));
    if (touching) add('not_fee_payer', 'high', 'They pay the gas, your assets flow out', `The fee payer is ${short(surface.feePayer)} and you are only a co-signer, but the instructions touch your accounts. Who pays gas does not matter; who signs does.`, { howToSpot: 'The fee payer is not you, while the instruction owner / authority is' });
  }
  // C4 unresolved ALT
  for (const ix of ixs) for (const [role, v] of Object.entries(ix.accounts || {})) if (isUnresolved(v) && ['delegate', 'newAuthority', 'newAuthorized', 'destination', 'destinationOwner', 'to'].includes(role)) {
    add('alt_unresolved', 'medium', `${role} hidden in a lookup table`, `The ${role} of ${ix.type} points at entry ${v.index} of lookup table ${short(v.lookup)}, which the wallet cannot resolve. The account you cannot see is the most important part of the whole transaction.`, { howToSpot: 'The wallet shows "unknown account" or a lookup table reference; a simulation resolves it' });
  }
  // C5 simulation failed
  if (surface.walletSimulation && surface.walletSimulation !== 'ok') {
    add('simulation_hidden', 'low', `Wallet simulation ${surface.walletSimulation === 'failed' ? 'failed' : 'unavailable'}`, 'Balance changes are not visible. On its own this only means "cannot see", not "something is wrong"; an expired blockhash does the same. Worth simulating again.', { howToSpot: 'The wallet says it cannot preview the changes' });
  }
  // C9 everything at once
  {
    const kinds = new Set(ixs.filter((ix) => SENSITIVE.has(ix.type) && !(TRANSFER.has(ix.type) && isSelf(ix.accounts?.to || ix.accounts?.destinationOwner || ix.accounts?.destination)) && !(ix.type === 'CloseAccount' && isSelf(ix.accounts?.destination))).map((ix) => ix.type.replace('Checked', '')));
    if (kinds.size >= 3) add('mixed_sensitive_ops', 'high', 'Several sensitive operations packed into one transaction', `${[...kinds].join(' + ')} in a single transaction: the classic shape of a drainer kit.`, { howToSpot: 'Count the kinds of sensitive instructions' });
  }
  // F1 / A9 / B5 label does not match the instruction type
  for (const ix of ixs) {
    const label = (ix.label || '').toLowerCase();
    if (!label) continue;
    const expectsReceive = /claim|mint|verify|sign|login|revoke|reward|airdrop|list/.test(label);
    const gives = APPROVE.has(ix.type) || AUTHORITY_CHANGE.has(ix.type) || ix.type === 'Assign' || (ix.type === 'CloseAccount' && !isSelf(ix.accounts?.destination)) || (TRANSFER.has(ix.type) && !isSelf(ix.accounts?.to || ix.accounts?.destinationOwner || ix.accounts?.destination));
    if (expectsReceive && gives && !(label === 'list' && APPROVE.has(ix.type) && KNOWN_PROGRAM_AUTHORITIES[addr(ix.accounts?.delegate)])) {
      add('label_mismatch', 'medium', `Button says "${ix.label}", instruction is ${ix.type}`, `The dapp labels this instruction "${ix.label}", but its actual type is ${ix.type}: you expect to receive something, yet the instruction gives away authority or assets.`, { howToSpot: 'Compare the dapp label with the decoded instruction type' });
    }
  }
  // B5 NFT outflow
  for (const o of outflows) if (o.ix.args?.decimals === 0 && o.amount === 1 && !bookAddrs.includes(addr(o.to))) {
    add('nft_outflow', 'high', 'NFT transferred out', `${o.symbol} goes to ${short(o.to)}. An amount of 1 looks harmless, but it is an entire NFT.`, { howToSpot: 'A TransferChecked with decimals = 0 and amount = 1' });
  }
  // H1 priority fee
  {
    const units = ixs.find((ix) => ix.type === 'SetComputeUnitLimit')?.args?.units ?? 200000;
    const price = ixs.find((ix) => ix.type === 'SetComputeUnitPrice')?.args?.microLamports ?? 0;
    const feeSol = (units * price) / 1e6 / 1e9;
    if (feeSol >= 0.05) add('priority_fee_excess', 'high', `Priority fee ${feeSol} SOL`, `${units.toLocaleString()} CU × ${price.toLocaleString()} microLamports = ${feeSol} SOL, burned even without a single transfer instruction.`, { howToSpot: 'When you see SetComputeUnitPrice, compute units × microLamports ÷ 10^15' });
    else if (feeSol >= 0.005) add('priority_fee_high', 'medium', `Priority fee on the high side: ${feeSol} SOL`, 'A normal priority fee is on the order of 0.0001 SOL.', { howToSpot: 'Compute units × microLamports' });
  }
  // D2 program label impersonates a known program
  for (const ix of ixs) {
    const label = ix.programLabel || '';
    const claimed = Object.entries(KNOWN_PROGRAMS).find(([, name]) => label && name.toLowerCase().startsWith(label.toLowerCase().split(' ')[0]) && label.length > 3);
    if (claimed && claimed[0] !== ix.program && !SYSTEM_PROGRAMS[ix.program]) {
      add('program_label_mismatch', 'high', `Label says ${label}, but the program ID is not it`, `${claimed[1]} has ID ${short(claimed[0])}; this instruction calls ${short(ix.program)}. The matching prefix is deliberate.`, { howToSpot: 'Compare the full program ID, not just the prefix' });
    }
  }
  // G1 symbol impersonates an official mint
  for (const ix of ixs) {
    const sym = ix.args?.symbol || ix.args?.outSymbol;
    const mint = ix.accounts?.mint || ix.args?.outMint;
    if (sym && mint && KNOWN_MINTS[sym] && KNOWN_MINTS[sym] !== mint && (ix.type === 'CreateAssociatedTokenAccount' || ix.args?.outMint)) {
      add('symbol_mint_mismatch', 'high', `"${sym}" is not the official ${sym}`, `The mint you receive is ${short(mint)}; the official ${sym} mint is ${short(KNOWN_MINTS[sym])}. A symbol can be anything.`, { howToSpot: 'Compare the full mint of the token you receive with the official mint' });
    }
  }
  // D6 / G5 zero slippage
  for (const ix of ixs) if (ix.args && 'minOut' in ix.args && num(ix.args.minOut) === 0 && num(ix.args.inAmount) > 0) {
    add('zero_min_out', 'high', 'Minimum received is 0', `${ix.args.inAmount} ${ix.args.inSymbol} for ${ix.args.outSymbol} with minOut = 0: receiving 0 still counts as success, and a sandwich bot will take most of it. When the program and domain are both right, this is a tampered front end or extension.`, { howToSpot: 'Check the minOut / slippage parameter of the swap instruction' });
  }
  // D4 an unknown program got hold of your token accounts
  for (const ix of ixs) if (!SYSTEM_PROGRAMS[ix.program] && !KNOWN_PROGRAMS[ix.program]) {
    const touches = Object.values(ix.accounts || {}).filter((v) => typeof v === 'string' && isSelf(v) && v !== user);
    if (touches.length && !facts.programs?.[ix.program]) add('unknown_program_touches_assets', 'medium', 'Unknown program has your token accounts', `${ix.programLabel || short(ix.program)} (${short(ix.program)}) is not in the known program list, and its account list includes your ${touches.map(short).join(', ')}. Inside the program it can do anything to those accounts that you have signed for.`, { howToSpot: 'Unrecognized program ID + your own token accounts in its account list; a simulation and a program check settle it' });
  }
  // E2 / E3 what the domain reveals for free
  if (surface.domain) {
    if (hasNonAscii(surface.domain)) add('domain_non_ascii', 'high', 'Domain contains non-ASCII characters', `"${surface.domain}" contains non-ASCII characters (homoglyphs) that the eye cannot tell apart.`, { howToSpot: 'A program checks the domain character set; a person can only rely on bookmarks' });
    const root = rootDomain(surface.domain);
    const brands = ['jup.ag', 'raydium.io', 'marinade.finance', 'drift.trade', 'magiceden.io', 'phantom.app', 'orca.so', 'tensor.trade'];
    const embedded = brands.find((b) => surface.domain !== b && !surface.domain.endsWith('.' + b) && surface.domain.includes(b));
    if (embedded) add('domain_subdomain_trick', 'high', 'Official domain is only part of a subdomain', `The root domain of "${surface.domain}" is ${root}; ${embedded} is just the text in front of it.`, { howToSpot: 'Read the domain right to left; the second-to-last label is the real owner' });
  }
  // I1 pressure language
  if (intent.urgency) add('urgency_language', 'low', 'Pressure language', 'Phrases like "right now / frozen / within 10 minutes" are a weak signal and do not convict on their own, but a legitimate project never rushes you into signing.', { howToSpot: 'The prompt has a deadline and a threat' });

  // ===== Rules that need ground truth =====
  const sim = facts.simulation;
  if (sim) {
    if (sim.ok === false) add('sim_failed', 'low', 'Simulation failed', `The simulation returned an error: ${sim.error || 'unknown'}.`, { evidence: 'simulation' });
    // hidden_outflow / pay_without_receive
    const inflow = (sim.tokens || []).filter((t) => t.delta > 0).length + (sim.sol?.delta > 0 ? 1 : 0);
    const outs = [...(sim.tokens || []).filter((t) => t.delta < 0).map((t) => ({ symbol: t.symbol, amount: -t.delta, pre: t.pre })), ...(sim.sol?.delta < -0.01 ? [{ symbol: 'SOL', amount: -sim.sol.delta, pre: sim.sol.pre }] : [])];
    for (const o of outs) {
      const ratio = o.pre > 0 ? o.amount / o.pre : 0;
      const shownAmount = outflows.filter((x) => x.symbol === o.symbol).reduce((s, x) => s + (x.amount || 0), 0) + ixs.filter((ix) => ix.args?.inSymbol === o.symbol).reduce((s, ix) => s + num(ix.args.inAmount), 0) + ixs.filter((ix) => ix.type === 'BurnChecked' && ix.args?.symbol === o.symbol).reduce((s, ix) => s + num(ix.args.uiAmount), 0);
      const hidden = o.amount > shownAmount * 1.05 + 0.01;
      if (hidden && (ratio >= 0.3 || o.amount >= 1)) add('hidden_outflow', 'high', `Simulation shows ${o.symbol} down by ${o.amount}, with no matching instruction in the popup`, `The visible ${o.symbol} spend in the instruction list is ${shownAmount}; the simulation shows ${o.amount} actually leaving (${Math.round(ratio * 100)}% of the balance). The difference happens inside a program (CPI) or in fees.${sim.notes ? ' Simulation note: ' + sim.notes : ''}`, { evidence: 'simulation', howToSpot: 'The simulated balance changes do not match the instruction list' });
      else if (ratio >= 0.5 && !intent.transfer && !intent.swap && !intent.stake && !intent.deposit) add('outflow_vs_balance', 'high', `Simulation shows ${Math.round(ratio * 100)}% of the ${o.symbol} balance leaving`, `${o.amount} ${o.symbol} leaves, while the prompt says "${surface.prompt}".`, { evidence: 'simulation', howToSpot: 'The simulated balance changes' });
    }
    if ((intent.mint || intent.claim || intent.deposit || intent.swap) && outs.length && inflow === 0 && !ixs.some((ix) => ix.type === 'OrderUnstake' || ix.type === 'CreateAccount')) {
      add('pay_without_receive', 'high', 'Only outflows, nothing comes in', `The simulation shows ${outs.map((o) => `${o.amount} ${o.symbol}`).join(', ')} leaving and no asset coming in. ${intent.mint ? 'A mint should deliver an NFT' : intent.swap ? 'A swap should deliver the target token' : intent.deposit ? 'A deposit should deliver share tokens' : 'A claim should deliver something'}.`, { evidence: 'simulation', howToSpot: 'The simulated inflow list is empty' });
    }
    for (const d of sim.delegates || []) {
      const shown = ixs.some((ix) => APPROVE.has(ix.type) && addr(ix.accounts?.delegate) === d.delegate);
      const isProg = KNOWN_PROGRAM_AUTHORITIES[d.delegate] || facts.addresses?.[d.delegate]?.reputation === 'program';
      if (!isProg && !shown) add('delegate_granted_sim', 'high', `Simulation shows ${d.symbol} delegated to ${short(d.delegate)}`, `Allowance ${d.amount}. This delegation is not visible in the popup (hidden in a CPI or lookup table); the simulation surfaced it.`, { evidence: 'simulation', howToSpot: 'The token account delegate field changed after simulation' });
    }
    for (const a of sim.authorities || []) {
      const shown = ixs.some((ix) => AUTHORITY_CHANGE.has(ix.type) && addr(ix.accounts?.newAuthority || ix.accounts?.newAuthorized) === a.to);
      if (!isSelf(a.to) && !shown) add('authority_changed_sim', 'high', `Simulation shows the ${a.type} authority of ${short(a.account)} becoming ${short(a.to)}`, 'There is no matching SetAuthority in the popup; the authority change happens inside a program.', { evidence: 'simulation', howToSpot: 'The account authority field changed after simulation' });
    }
    if (sim.feeLamports && sim.feeLamports / 1e9 >= 0.05 && !findings.some((f) => f.rule === 'priority_fee_excess')) add('priority_fee_excess', 'high', `Simulation shows a fee of ${sim.feeLamports / 1e9} SOL`, 'The fee comes from the compute budget priority fee.', { evidence: 'simulation' });
    if (sim.rent?.lamports >= 0.5e9) add('rent_outflow', 'high', `Rent outflow of ${sim.rent.lamports / 1e9} SOL`, `Creates ${sim.rent.created} accounts whose rent goes to accounts closable by ${short(sim.rent.closableBy)}.`, { evidence: 'simulation' });
  }

  // Address reputation
  if (facts.addresses) {
    const seen = new Set();
    const list = [...counterparties.map((c) => ({ address: c.address, role: c.role })), ...(sim?.delegates || []).map((d) => ({ address: d.delegate, role: 'delegate' })), ...(sim?.authorities || []).map((a) => ({ address: a.to, role: 'newAuthority' }))];
    for (const c of list) {
      const rep = facts.addresses[c.address];
      if (!rep || seen.has(c.address)) continue;
      seen.add(c.address);
      const roleName = { delegate: 'Delegate', newAuthority: 'New authority holder', closeDestination: 'Close-account recipient', recipient: 'Recipient', feePayer: 'Fee payer', newOwner: 'New owner' }[c.role] || c.role;
      if (['drainer', 'scam', 'poisoning'].includes(rep.reputation)) add('counterparty_flagged', 'high', `${roleName} is a flagged address: ${rep.label || rep.reputation}`, `${short(c.address)}: ${rep.notes || ''}`, { evidence: 'addresses', howToSpot: 'Check the address reputation' });
      else if (rep.reputation === 'known') add('counterparty_known', 'green', `${roleName} is a known address: ${rep.label}`, `${short(c.address)}: ${rep.notes || ''}`, { evidence: 'addresses' });
      else if (rep.reputation === 'program') add('counterparty_program', 'green', `${roleName} is a program account: ${rep.label}`, rep.notes || '', { evidence: 'addresses' });
      else if (rep.reputation === 'unknown' && rep.firstSeenDaysAgo != null && rep.firstSeenDaysAgo <= 3 && c.role !== 'feePayer') add('counterparty_fresh', 'medium', `${roleName} first appeared only ${rep.firstSeenDaysAgo} days ago`, `${short(c.address)} has no history.`, { evidence: 'addresses' });
    }
  }

  // Program / mint check
  if (facts.programs) {
    for (const ix of ixs) {
      if (SYSTEM_PROGRAMS[ix.program]) continue;
      const p = facts.programs[ix.program];
      if (!p || p.kind !== 'program') continue;
      if (p.lookalikeOf) add('program_lookalike', 'high', `Program ID imitates ${KNOWN_PROGRAMS[p.lookalikeOf] || short(p.lookalikeOf)}`, `${short(ix.program)} is unverified, was deployed ${p.deployedDaysAgo} days ago, and its upgrade authority is the hot wallet ${short(p.upgradeAuthority)}.`, { evidence: 'programs' });
      else if (!p.verified) add('unverified_program', p.upgradeAuthorityKind === 'hot-wallet' && p.deployedDaysAgo <= 30 ? 'high' : 'medium', `Unverified program: ${p.name}`, `${short(ix.program)} has no verified build, was deployed ${p.deployedDaysAgo} days ago, and its upgrade authority is ${p.upgradeAuthorityKind === 'hot-wallet' ? 'the hot wallet ' + short(p.upgradeAuthority) : p.upgradeAuthorityKind}. The program's code can change at any time.`, { evidence: 'programs' });
      else add('verified_program', 'green', `Verified program: ${p.name}`, `${p.upgradeable ? `Upgradeable, upgrade authority is ${p.upgradeAuthorityKind === 'multisig' ? 'a multisig' : p.upgradeAuthorityKind}` : 'Not upgradeable'}, deployed ${p.deployedDaysAgo} days ago. Upgradeable is not a red flag; a hot-wallet upgrade authority is.`, { evidence: 'programs' });
    }
    // Received mints
    const received = new Set();
    for (const ix of ixs) { if (ix.type === 'CreateAssociatedTokenAccount' && isSelf(ix.accounts?.owner)) received.add(ix.accounts.mint); if (ix.args?.outMint) received.add(ix.args.outMint); }
    for (const t of sim?.tokens || []) if (t.delta > 0) received.add(t.mint);
    for (const mint of received) {
      const m = facts.programs[mint];
      if (!m || m.kind !== 'mint') continue;
      if (m.impersonates) add('fake_mint', 'high', `The "${m.symbol}" you receive is a fake`, `${short(mint)} impersonates ${short(m.impersonates)}; created ${m.ageDays} days ago, ${m.holders} holders.`, { evidence: 'programs' });
      const traps = [];
      if ((m.extensions || []).includes('permanentDelegate')) traps.push('permanentDelegate (the issuer can pull tokens out at any time)');
      if ((m.extensions || []).includes('transferHook')) traps.push('transferHook (the hook program can refuse transfers out)');
      if (m.freezeAuthorityKind === 'hot-wallet') traps.push('freeze authority is a hot wallet (can freeze your account)');
      if (m.mintAuthorityKind === 'hot-wallet') traps.push('mint authority is a hot wallet');
      if (traps.length) add('honeypot_mint', traps.some((t) => /permanentDelegate|transferHook|freeze/.test(t)) ? 'high' : 'medium', `Asset trap: ${m.symbol}`, `The transaction itself is normal, but the token you buy has: ${traps.join('; ')}.${m.ageDays != null ? ` Mint created ${m.ageDays} days ago.` : ''}${m.notes ? ' ' + m.notes : ''}`, { evidence: 'programs', howToSpot: 'Check the mint\'s freeze / mint authority and its Token-2022 extensions' });
    }
  }

  // Domain verification
  if (facts.domain && surface.domain) {
    const d = facts.domain;
    if (d.known) add('domain_known', 'green', `Domain belongs to ${d.officialOf}`, `${surface.domain} was registered ${d.registeredDaysAgo} days ago. Note: a right domain ≠ a right transaction; the front end can be poisoned.`, { evidence: 'domain' });
    else if (d.lookalikeOf) add('domain_lookalike', 'high', `Domain imitates ${d.lookalikeOf}`, `${surface.domain} (${{ brand: 'brand word', typo: 'typosquat', homoglyph: 'homoglyph', subdomain: 'subdomain' }[d.lookalikeKind] || d.lookalikeKind}), registered ${d.registeredDaysAgo} days ago. ${d.notes || ''}`, { evidence: 'domain' });
    else if (d.registeredDaysAgo != null && d.registeredDaysAgo <= 30) add('domain_fresh', 'medium', `Domain registered ${d.registeredDaysAgo} days ago`, `${surface.domain} has no history.`, { evidence: 'domain' });
    else add('domain_unknown', 'low', 'Domain not on the known list', `${surface.domain} is neither a known official domain nor shows signs of imitation.`, { evidence: 'domain' });
  }

  // ===== Summary =====
  const count = (s) => findings.filter((f) => f.severity === s).length;
  const H = count('high'), M = count('medium'), L = count('low'), G = count('green');
  const score = findings.reduce((s, f) => s + SEV_WEIGHT[f.severity], 0);
  let verdict, confidence;
  if (H > 0) { verdict = 'scam'; confidence = Math.min(0.98, 0.9 + 0.02 * H); }
  else if (score >= 2.5) { verdict = 'scam'; confidence = Math.min(0.85, 0.6 + 0.1 * (M - 2)); }
  else { verdict = 'safe'; confidence = Math.max(0.3, Math.min(0.95, 0.5 + 0.15 * G - 0.15 * M - 0.05 * L)); }

  // Which evidence is still missing (the agent decides whether to pay for it)
  const missing = [];
  const hasTx = surface.signMode !== 'message' || surface.message?.looksLikeTransaction;
  if (hasTx && !facts.simulation) missing.push({ kind: 'simulation', reason: 'cannot see balance / authority changes inside programs' });
  const cpAddrs = [...new Set([...counterparties.map((c) => c.address), ...(sim?.delegates || []).map((d) => d.delegate), ...(sim?.authorities || []).map((a) => a.to)])].filter((a) => !KNOWN_PROGRAM_AUTHORITIES[a] && !facts.addresses?.[a]);
  if (cpAddrs.length) missing.push({ kind: 'addresses', reason: `no reputation for ${cpAddrs.map(short).join(', ')}`, targets: cpAddrs });
  const progs = [...new Set([...ixs.filter((ix) => !SYSTEM_PROGRAMS[ix.program]).map((ix) => ix.program), ...ixs.filter((ix) => ix.type === 'CreateAssociatedTokenAccount' && isSelf(ix.accounts?.owner)).map((ix) => ix.accounts.mint), ...ixs.map((ix) => ix.args?.outMint).filter(Boolean), ...(sim?.tokens || []).filter((t) => t.delta > 0).map((t) => t.mint)])].filter((p) => !facts.programs?.[p]);
  if (progs.length) missing.push({ kind: 'programs', reason: `${progs.map((p) => KNOWN_PROGRAMS[p] || short(p)).join(', ')} not checked`, targets: progs });
  if (surface.domain && !facts.domain) missing.push({ kind: 'domain', reason: `${surface.domain} not verified` });

  return { verdict, confidence: Number(confidence.toFixed(2)), score, findings, counts: { high: H, medium: M, low: L, green: G }, missing, counterparties };
}

// ---------- Coaching after the answer ----------
export function coach(question, analysis, answer) {
  const truth = question.truth;
  const correct = answer === truth;
  const reds = analysis.findings.filter((f) => f.severity === 'high' || f.severity === 'medium');
  const lows = analysis.findings.filter((f) => f.severity === 'low');
  const greens = analysis.findings.filter((f) => f.severity === 'green');
  const ev = (f) => ({ free: 'Visible in the popup', simulation: 'Needs a paid simulation', addresses: 'Needs an address reputation check', programs: 'Needs a program check', domain: 'Needs domain verification' }[f.evidence] || f.evidence);
  const item = (f) => ({ severity: f.severity, title: f.title, detail: f.detail, howToSpot: f.howToSpot || null, evidence: ev(f) });
  let headline, sections = [];
  if (!correct && truth === 'scam') {
    headline = answer === 'timeout' ? 'Time ran out — this was a scam' : 'You approved a scam';
    sections.push({ title: 'Red flags', items: reds.map(item) });
    if (greens.length) sections.push({ title: 'Why it looked legitimate', items: greens.map(item) });
  } else if (!correct && truth === 'safe') {
    headline = answer === 'timeout' ? 'Time ran out — this was actually a legitimate transaction' : 'You rejected a legitimate transaction';
    const scary = [...reds, ...lows];
    if (scary.length) sections.push({ title: 'What alarmed you, and why it doesn\'t hold up', items: scary.map(item) });
    else sections.push({ title: 'What alarmed you', items: [{ severity: 'low', title: 'The detector found no red flags', detail: 'Perhaps the number of instructions, an unfamiliar program name, or words like "close / burn / approve" made it look tense.', howToSpot: null, evidence: 'Visible in the popup' }] });
    sections.push({ title: 'Why it is safe', items: greens.map(item) });
  } else if (truth === 'scam') {
    headline = 'Correct — this is a scam';
    sections.push({ title: 'Red flags', items: reds.map(item) });
  } else {
    headline = 'Correct — this is a legitimate transaction';
    sections.push({ title: 'Why it is safe', items: greens.map(item) });
    if (reds.length || lows.length) sections.push({ title: 'Easy to misread', items: [...reds, ...lows].map(item) });
  }
  return { correct, truth, answer, headline, sections, lesson: question.lesson, cases: question.case };
}
