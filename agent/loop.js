// The agent loop: look at the question → free heuristics → buy checks while confidence is too low → re-judge → answer.
// Every paid step goes through the budget; a refusal stops the loop with an explanation, and every payment is written to the ledger.
import { analyze, EVIDENCE_PRICES_USD, KNOWN_PROGRAMS } from '../server/detector.js';

const ROUTES = { simulation: '/check/simulate', addresses: '/check/address', programs: '/check/program', domain: '/check/domain' };
const ORDER = ['simulation', 'addresses', 'programs', 'domain']; // most informative first
const short = (a) => (typeof a === 'string' && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : String(a));

export async function playRound({ question, baseUrl, budget, payer, ledger, threshold = 0.8, maxPurchases = 4, fetchImpl = fetch, log = () => {} }) {
  const { id, surface } = question;
  const transcript = [];
  const say = (type, text, extra = {}) => { const step = { type, text, ...extra }; transcript.push(step); log(step); };
  const facts = {};
  let spentThisRound = 0;

  let analysis = analyze(surface, facts);
  say('look', `Question ${question.index + 1} "${question.title}": ${surface.domain || 'in-wallet action'} · ${surface.instructions.length} instructions · "${surface.prompt}"`);
  say('free', `Free heuristics: ${describe(analysis)}`, { analysis: slim(analysis) });

  let purchases = 0;
  while (analysis.confidence < threshold && purchases < maxPurchases) {
    const next = pickNext(analysis, facts);
    if (!next) { say('stop', 'No more evidence to buy; answering on the current judgment.'); break; }
    const price = EVIDENCE_PRICES_USD[next.kind];
    const why = `${Math.round(analysis.confidence * 100)}% confident, ${next.reason}`;
    const r = budget.reserve(price, why);
    if (!r.ok) {
      say('refused', `Wanted to spend $${price} on ${label(next.kind)} (${next.reason}); the budget refused: ${r.detail}. Stopping purchases and answering on the current judgment.`, { reason: r.reason, remaining: r.remaining });
      ledger.append({ question: id, route: ROUTES[next.kind], priceUsd: price, status: 'refused', reason: r.reason, why });
      break;
    }
    say('decide', `${why}; $${price} for ${label(next.kind)} is worth it ($${r.remaining} left).`);
    const body = bodyFor(next, id);
    const res = await buy(`${baseUrl}${ROUTES[next.kind]}`, body, { payer, fetchImpl });
    purchases++;
    if (!res.ok) {
      budget.refund(price);
      ledger.append({ question: id, route: ROUTES[next.kind], priceUsd: price, status: 'failed', error: res.error, why });
      say('error', `Buying ${label(next.kind)} failed: ${res.error}; refunded $${price}.`);
      continue;
    }
    spentThisRound += price;
    ledger.append({ question: id, route: ROUTES[next.kind], priceUsd: price, status: 'settled', proof: res.proof, receiptId: res.receiptId, why, input: body });
    mergeFacts(facts, next.kind, res.data);
    analysis = analyze(surface, facts);
    say('bought', `Bought ${label(next.kind)}: ${summarize(next.kind, res.data)}`, { data: res.data });
    say('update', `Re-judged: ${describe(analysis)}`, { analysis: slim(analysis) });
  }

  say('answer', `Answer: ${analysis.verdict === 'scam' ? 'Scam' : 'Safe'} (${Math.round(analysis.confidence * 100)}%); spent $${spentThisRound.toFixed(3)} on this question.`);
  return { verdict: analysis.verdict, confidence: analysis.confidence, analysis, transcript, spentUsd: spentThisRound, facts };
}

// 402 → pay → retry. Returns { ok, data, proof, receiptId } or { ok:false, error }.
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
function label(kind) { return { simulation: 'transaction simulation', addresses: 'address reputation', programs: 'program check', domain: 'domain verification' }[kind]; }
function describe(a) {
  const reds = a.findings.filter((f) => f.severity === 'high' || f.severity === 'medium').map((f) => f.title);
  const greens = a.findings.filter((f) => f.severity === 'green').map((f) => f.title);
  const parts = [];
  if (reds.length) parts.push(`${reds.length} red flag${reds.length === 1 ? '' : 's'} (${reds.slice(0, 3).join('; ')}${reds.length > 3 ? '…' : ''})`);
  if (greens.length) parts.push(`${greens.length} green light${greens.length === 1 ? '' : 's'} (${greens.slice(0, 2).join('; ')}${greens.length > 2 ? '…' : ''})`);
  if (!parts.length) parts.push('no signals found');
  return `${parts.join(', ')}. Leaning ${a.verdict === 'scam' ? 'Scam' : 'Safe'}, ${Math.round(a.confidence * 100)}% confident${a.missing.length ? `; still missing: ${a.missing.map((m) => label(m.kind)).join(', ')}` : ''}`;
}
function summarize(kind, data) {
  if (kind === 'simulation') {
    const parts = [];
    if (data.sol?.delta) parts.push(`SOL ${data.sol.delta > 0 ? '+' : ''}${data.sol.delta}`);
    for (const t of data.tokens || []) parts.push(`${t.symbol} ${t.delta > 0 ? '+' : ''}${t.delta}`);
    for (const d of data.delegates || []) parts.push(`${d.symbol} delegated to ${short(d.delegate)} (${d.amount})`);
    for (const a of data.authorities || []) parts.push(`${a.type} authority of ${short(a.account)} → ${short(a.to)}`);
    return (parts.join(', ') || 'no balance changes') + (data.notes ? `. ${data.notes}` : '');
  }
  if (kind === 'addresses') return Object.entries(data).map(([a, r]) => `${short(a)}: ${r.label || r.reputation}${r.notes ? ', ' + r.notes : ''}`).join('; ');
  if (kind === 'programs') return Object.entries(data).map(([a, p]) => p.kind === 'mint' ? `${p.symbol}: freeze=${p.freezeAuthorityKind} mint=${p.mintAuthorityKind}${p.extensions?.length ? ' extensions ' + p.extensions.join('/') : ''}${p.impersonates ? ' impersonates ' + short(p.impersonates) : ''}` : `${p.name || KNOWN_PROGRAMS[a] || short(a)}: ${p.verified ? 'verified' : 'unverified'}, upgrade authority ${p.upgradeAuthorityKind}${p.lookalikeOf ? ', imitates ' + short(p.lookalikeOf) : ''}`).join('; ');
  if (kind === 'domain') return data.known ? `${data.name} belongs to ${data.officialOf}` : data.lookalikeOf ? `${data.name} imitates ${data.lookalikeOf} (${data.lookalikeKind})` : `${data.name} unknown, registered ${data.registeredDaysAgo ?? '?'} days ago`;
  return JSON.stringify(data).slice(0, 200);
}
function slim(a) { return { verdict: a.verdict, confidence: a.confidence, counts: a.counts, findings: a.findings.map((f) => ({ rule: f.rule, severity: f.severity, title: f.title, evidence: f.evidence })), missing: a.missing.map((m) => m.kind) }; }
