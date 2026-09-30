// 入口：静态页 + 游戏 API + 四条付费检查 + agent 触发。
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKnowledge } from './knowledge.js';
import { createChecks } from './checks.js';
import { createPaywall } from './payment.js';
import { createLedger } from './ledger.js';
import { analyze, coach, EVIDENCE_PRICES_USD } from './detector.js';
import { playRound } from '../agent/loop.js';
import { createBudget } from '../agent/budget.js';
import { createPayer } from '../agent/payer.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp(env = process.env) {
  const knowledge = loadKnowledge();
  const scheme = env.PAYMENT_SCHEME || 'mock';
  const rpc = env.SOLANA_RPC || 'https://api.devnet.solana.com';
  const checks = createChecks(knowledge, { liveMode: env.LIVE === '1', rpc });
  const paywall = createPaywall({ scheme, payTo: env.PAYEE_ADDRESS || 'ScamOrSafePayee11111111111111111111111111111', solUsd: Number(env.SOL_USD || 150), rpc });
  const ledger = createLedger(env.LEDGER_PATH === '' ? null : env.LEDGER_PATH || path.join(here, '..', 'out', 'agent-ledger.jsonl'));
  const budget = createBudget({ limitUsd: Number(env.AGENT_BUDGET_USD || 0.25), perCallMaxUsd: Number(env.AGENT_PER_CALL_MAX_USD || 0.05) });
  const payer = createPayer({ scheme, keypairSecret: env.AGENT_KEYPAIR, rpc });

  const state = { scores: { human: { right: 0, wrong: 0 }, agent: { right: 0, wrong: 0 } }, answers: {} };
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use(express.static(path.join(here, '..', 'web')));
  app.locals.baseUrl = null; // listen 之后填

  app.get('/health', (_req, res) => res.json({ ok: true, scheme, questions: knowledge.questions.length, prices: EVIDENCE_PRICES_USD }));

  // ---- 游戏 ----
  app.get('/api/questions', (_req, res) => res.json(knowledge.questions.map((q) => ({ id: q.id, index: q.index, title: q.title, answered: state.answers[q.id] || null }))));
  app.get('/api/questions/:id', (req, res) => {
    const q = knowledge.byId.get(req.params.id);
    if (!q) return res.status(404).json({ error: 'unknown question' });
    res.json(knowledge.publicView(q));
  });
  app.post('/api/questions/:id/answer', (req, res) => {
    const q = knowledge.byId.get(req.params.id);
    if (!q) return res.status(404).json({ error: 'unknown question' });
    const { who = 'human', answer } = req.body || {};
    if (!['scam', 'safe', 'timeout'].includes(answer)) return res.status(400).json({ error: 'answer must be scam | safe | timeout' });
    const analysis = analyze(q.surface, knowledge.fullFacts(q));
    const c = coach(q, analysis, answer);
    if (!state.answers[q.id]) state.answers[q.id] = {};
    if (!state.answers[q.id][who]) { state.scores[who][c.correct ? 'right' : 'wrong']++; state.answers[q.id][who] = { answer, correct: c.correct }; }
    res.json({ ...c, analysis: { verdict: analysis.verdict, confidence: analysis.confidence, counts: analysis.counts, findings: analysis.findings }, cases: q.case.map((id) => knowledge.caseById.get(id)).filter(Boolean).map((x) => ({ id: x.id, name: x.name, trick: x.trick })), scores: state.scores });
  });
  app.post('/api/questions/:id/agent', async (req, res) => {
    const q = knowledge.byId.get(req.params.id);
    if (!q) return res.status(404).json({ error: 'unknown question' });
    const baseUrl = app.locals.baseUrl || `http://127.0.0.1:${env.PORT || 4100}`;
    try {
      const r = await playRound({ question: knowledge.publicView(q), baseUrl, budget, payer, ledger, threshold: Number(req.body?.threshold || 0.8) });
      const analysis = analyze(q.surface, knowledge.fullFacts(q));
      const c = coach(q, analysis, r.verdict);
      if (!state.answers[q.id]) state.answers[q.id] = {};
      if (!state.answers[q.id].agent) { state.scores.agent[c.correct ? 'right' : 'wrong']++; state.answers[q.id].agent = { answer: r.verdict, correct: c.correct }; }
      res.json({ transcript: r.transcript, verdict: r.verdict, confidence: r.confidence, spentUsd: r.spentUsd, correct: c.correct, truth: q.truth, budget: budget.state(), ledger: ledger.all().slice(-10), scores: state.scores });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/state', (_req, res) => res.json({ scores: state.scores, answers: state.answers, budget: budget.state(), ledger: ledger.all().slice(-20), receipts: paywall.receipts.length, prices: EVIDENCE_PRICES_USD, scheme }));
  app.post('/api/reset', (_req, res) => { state.scores = { human: { right: 0, wrong: 0 }, agent: { right: 0, wrong: 0 } }; state.answers = {}; budget.reset(); ledger.clear(); res.json({ ok: true }); });
  app.get('/api/taxonomy', (_req, res) => res.json(knowledge.taxonomy));

  // ---- 四条付费检查 ----
  const paid = (kind, fn) => [paywall.charge(EVIDENCE_PRICES_USD[kind], { simulation: '交易模拟', addresses: '地址信誉', programs: '程序 / mint 体检', domain: '域名核验' }[kind]), async (req, res) => {
    try { res.json(await fn(req.body || {})); }
    catch (e) { res.status(400).json({ error: e.message }); }
  }];
  app.post('/check/address', ...paid('addresses', (b) => checks.address(b)));
  app.post('/check/simulate', ...paid('simulation', (b) => checks.simulate(b)));
  app.post('/check/program', ...paid('programs', (b) => checks.program(b)));
  app.post('/check/domain', ...paid('domain', (b) => checks.domain(b.domain ? b : { domain: knowledge.byId.get(b.questionId)?.surface.domain })));

  return { app, knowledge, paywall, ledger, budget, state };
}

export function start(env = process.env) {
  const port = Number(env.PORT || 4100);
  const { app, ...rest } = createApp(env);
  return new Promise((resolve) => {
    const server = app.listen(port, '127.0.0.1', () => {
      app.locals.baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, app, baseUrl: app.locals.baseUrl, ...rest });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { baseUrl, knowledge, paywall } = await start();
  console.log(`Scam or Safe  →  ${baseUrl}\n  题目 ${knowledge.questions.length} 道 · 付款方案 ${paywall.scheme} · 检查价格 ${JSON.stringify(EVIDENCE_PRICES_USD)}`);
}
