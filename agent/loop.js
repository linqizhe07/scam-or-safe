// agent 循环：看题 → 免费启发式 → 置信度不够就买检查 → 重新判断 → 作答。
// 花钱的每一步都过预算，被拒就停下并解释；每笔付款写账本。
import { analyze, EVIDENCE_PRICES_USD, KNOWN_PROGRAMS } from '../server/detector.js';

const ROUTES = { simulation: '/check/simulate', addresses: '/check/address', programs: '/check/program', domain: '/check/domain' };
const ORDER = ['simulation', 'addresses', 'programs', 'domain']; // 信息量从高到低
const short = (a) => (typeof a === 'string' && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : String(a));

export async function playRound({ question, baseUrl, budget, payer, ledger, threshold = 0.8, maxPurchases = 4, fetchImpl = fetch, log = () => {} }) {
  const { id, surface } = question;
  const transcript = [];
  const say = (type, text, extra = {}) => { const step = { type, text, ...extra }; transcript.push(step); log(step); };
  const facts = {};
  let spentThisRound = 0;

  let analysis = analyze(surface, facts);
  say('look', `第 ${question.index + 1} 题「${question.title}」：${surface.domain || '钱包内操作'} · ${surface.instructions.length} 条指令 · “${surface.prompt}”`);
  say('free', `免费启发式：${describe(analysis)}`, { analysis: slim(analysis) });

  let purchases = 0;
  while (analysis.confidence < threshold && purchases < maxPurchases) {
    const next = pickNext(analysis, facts);
    if (!next) { say('stop', '没有更多可买的证据了，按现有判断作答。'); break; }
    const price = EVIDENCE_PRICES_USD[next.kind];
    const why = `${Math.round(analysis.confidence * 100)}% 把握，${next.reason}`;
    const r = budget.reserve(price, why);
    if (!r.ok) {
      say('refused', `想花 $${price} 买${label(next.kind)}（${next.reason}），预算拒绝：${r.detail}。停止购买，按现有判断作答。`, { reason: r.reason, remaining: r.remaining });
      ledger.append({ question: id, route: ROUTES[next.kind], priceUsd: price, status: 'refused', reason: r.reason, why });
      break;
    }
    say('decide', `${why}，花 $${price} 买${label(next.kind)}值得（剩余 $${r.remaining}）。`);
    const body = bodyFor(next, id);
    const res = await buy(`${baseUrl}${ROUTES[next.kind]}`, body, { payer, fetchImpl });
    purchases++;
    if (!res.ok) {
      budget.refund(price);
      ledger.append({ question: id, route: ROUTES[next.kind], priceUsd: price, status: 'failed', error: res.error, why });
      say('error', `${label(next.kind)}失败：${res.error}，退回 $${price}。`);
      continue;
    }
    spentThisRound += price;
    ledger.append({ question: id, route: ROUTES[next.kind], priceUsd: price, status: 'settled', proof: res.proof, receiptId: res.receiptId, why, input: body });
    mergeFacts(facts, next.kind, res.data);
    analysis = analyze(surface, facts);
    say('bought', `${label(next.kind)}结果：${summarize(next.kind, res.data)}`, { data: res.data });
    say('update', `重新判断：${describe(analysis)}`, { analysis: slim(analysis) });
  }

  say('answer', `作答：${analysis.verdict === 'scam' ? 'Scam' : 'Safe'}（${Math.round(analysis.confidence * 100)}%），本题花费 $${spentThisRound.toFixed(3)}。`);
  return { verdict: analysis.verdict, confidence: analysis.confidence, analysis, transcript, spentUsd: spentThisRound, facts };
}

// 402 → 付款 → 重试。返回 { ok, data, proof, receiptId } 或 { ok:false, error }。
export async function buy(url, body, { payer, fetchImpl = fetch }) {
  const post = (headers = {}) => fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    let res = await post();
    if (res.status === 402) {
      const quote = await res.json();
      const paid = await payer.pay(quote);
      res = await post({ 'x-payment': paid.header });
      if (res.status === 402) { const again = await res.json().catch(() => ({})); return { ok: false, error: `payment rejected: ${again.rejected || 'unknown'}` }; }
      if (!res.ok) return { ok: false, error: `${res.status} ${await res.text()}` };
      const out = await res.json();
      const pr = res.headers.get('x-payment-response');
      const receipt = pr ? JSON.parse(Buffer.from(pr, 'base64').toString('utf8')) : null;
      return { ok: true, data: out.data, proof: paid.proof, receiptId: receipt?.receiptId || null };
    }
    if (!res.ok) return { ok: false, error: `${res.status} ${await res.text()}` };
    return { ok: true, data: (await res.json()).data, proof: null, receiptId: null };
  } catch (e) { return { ok: false, error: e.message }; }
}

function pickNext(analysis, facts) {
  for (const kind of ORDER) {
    const m = analysis.missing.find((x) => x.kind === kind);
    if (!m) continue;
    if (kind === 'addresses' || kind === 'programs') {
      const target = (m.targets || []).find((t) => !facts[kind]?.[t]);
      if (!target) continue;
      return { kind, reason: m.reason, target };
    }
    return { kind, reason: m.reason };
  }
  return null;
}
function bodyFor(next, questionId) {
  if (next.kind === 'simulation') return { questionId };
  if (next.kind === 'addresses') return { address: next.target };
  if (next.kind === 'programs') return { address: next.target };
  if (next.kind === 'domain') return { domain: next.domain || undefined, questionId };
}
function mergeFacts(facts, kind, data) {
  if (kind === 'simulation' || kind === 'domain') facts[kind] = data;
  else facts[kind] = { ...(facts[kind] || {}), ...data };
}
function label(kind) { return { simulation: '交易模拟', addresses: '地址信誉', programs: '程序体检', domain: '域名核验' }[kind]; }
function describe(a) {
  const reds = a.findings.filter((f) => f.severity === 'high' || f.severity === 'medium').map((f) => f.title);
  const greens = a.findings.filter((f) => f.severity === 'green').map((f) => f.title);
  const parts = [];
  if (reds.length) parts.push(`红旗 ${reds.length} 条（${reds.slice(0, 3).join('；')}${reds.length > 3 ? '…' : ''}）`);
  if (greens.length) parts.push(`绿灯 ${greens.length} 条（${greens.slice(0, 2).join('；')}${greens.length > 2 ? '…' : ''}）`);
  if (!parts.length) parts.push('没有发现任何信号');
  return `${parts.join('，')}。倾向 ${a.verdict === 'scam' ? 'Scam' : 'Safe'}，${Math.round(a.confidence * 100)}% 把握${a.missing.length ? `；还缺：${a.missing.map((m) => label(m.kind)).join('、')}` : ''}`;
}
function summarize(kind, data) {
  if (kind === 'simulation') {
    const parts = [];
    if (data.sol?.delta) parts.push(`SOL ${data.sol.delta > 0 ? '+' : ''}${data.sol.delta}`);
    for (const t of data.tokens || []) parts.push(`${t.symbol} ${t.delta > 0 ? '+' : ''}${t.delta}`);
    for (const d of data.delegates || []) parts.push(`${d.symbol} 委托给 ${short(d.delegate)}（${d.amount}）`);
    for (const a of data.authorities || []) parts.push(`${short(a.account)} 的 ${a.type} 权限 → ${short(a.to)}`);
    return (parts.join('，') || '没有余额变化') + (data.notes ? `。${data.notes}` : '');
  }
  if (kind === 'addresses') return Object.entries(data).map(([a, r]) => `${short(a)}：${r.label || r.reputation}${r.notes ? '，' + r.notes : ''}`).join('；');
  if (kind === 'programs') return Object.entries(data).map(([a, p]) => p.kind === 'mint' ? `${p.symbol}：freeze=${p.freezeAuthorityKind} mint=${p.mintAuthorityKind}${p.extensions?.length ? ' 扩展 ' + p.extensions.join('/') : ''}${p.impersonates ? ' 冒充 ' + short(p.impersonates) : ''}` : `${p.name || KNOWN_PROGRAMS[a] || short(a)}：${p.verified ? '已验证' : '未验证'}，升级权限 ${p.upgradeAuthorityKind}${p.lookalikeOf ? '，仿冒 ' + short(p.lookalikeOf) : ''}`).join('；');
  if (kind === 'domain') return data.known ? `${data.name} 属于 ${data.officialOf}` : data.lookalikeOf ? `${data.name} 仿冒 ${data.lookalikeOf}（${data.lookalikeKind}）` : `${data.name} 未知，注册 ${data.registeredDaysAgo ?? '?'} 天`;
  return JSON.stringify(data).slice(0, 200);
}
function slim(a) { return { verdict: a.verdict, confidence: a.confidence, counts: a.counts, findings: a.findings.map((f) => ({ rule: f.rule, severity: f.severity, title: f.title, evidence: f.evidence })), missing: a.missing.map((m) => m.kind) }; }
