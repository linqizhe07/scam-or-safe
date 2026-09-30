// Entry point: static page + game API + the four paid checks + the agent trigger.
// The server is stateless: scores, the agent's running budget and its ledger live in the browser (localStorage) and are
// sent along with each request, so the same code runs as a long-lived process locally and as a serverless function on Vercel.
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
  const paywall = createPaywall({ scheme, payTo: env.PAYEE_ADDRESS || 'ScamOrSafePayee11111111111111111111111111111', solUsd: Number(env.SOL_USD || 150), rpc, secret: env.PAYMENT_SECRET });
  const payer = createPayer({ scheme, keypairSecret: env.AGENT_KEYPAIR, rpc });
  const defaultBudget = { limitUsd: Number(env.AGENT_BUDGET_USD || 0.25), perCallMaxUsd: Number(env.AGENT_PER_CALL_MAX_USD || 0.05) };

  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use(express.static(path.join(here, '..', 'public')));
  app.locals.baseUrl = null; // set by start(); on Vercel it is derived from the request headers
  const selfUrl = (req) => app.locals.baseUrl || `${req.get('x-forwarded-proto') || req.protocol || 'http'}://${req.get('host')}`;

  app.get('/health', (_req, res) => res.json({ ok: true, scheme, questions: knowledge.questions.length, prices: EVIDENCE_PRICES_USD }));
  app.get('/api/config', (_req, res) => res.json({ prices: EVIDENCE_PRICES_USD, scheme, budget: defaultBudget, questions: knowledge.questions.length }));
  app.get('/api/taxonomy', (_req, res) => res.json(knowledge.taxonomy));

  // ---- Game ----
  app.get('/api/questions', (_req, res) => res.json(knowledge.questions.map((q) => ({ id: q.id, index: q.index, title: q.title }))));
  app.get('/api/questions/:id', (req, res) => {
    const q = knowledge.byId.get(req.params.id);
    if (!q) return res.status(404).json({ error: 'unknown question' });
    res.json(knowledge.publicView(q));
  });
  // Grade an answer and explain. Pure: the browser keeps the scores.
  app.post('/api/questions/:id/answer', (req, res) => {
    const q = knowledge.byId.get(req.params.id);
    if (!q) return res.status(404).json({ error: 'unknown question' });
    const { answer } = req.body || {};
    if (!['scam', 'safe', 'timeout'].includes(answer)) return res.status(400).json({ error: 'answer must be scam | safe | timeout' });
    const analysis = analyze(q.surface, knowledge.fullFacts(q));
    const c = coach(q, analysis, answer);
    res.json({ ...c, analysis: { verdict: analysis.verdict, confidence: analysis.confidence, counts: analysis.counts, findings: analysis.findings }, cases: q.case.map((id) => knowledge.caseById.get(id)).filter(Boolean).map((x) => ({ id: x.id, name: x.name, trick: x.trick })) });
  });
  // Run the agent for one question. The caller passes the budget state it has so far and gets the new state plus this round's ledger back.
  app.post('/api/questions/:id/agent', async (req, res) => {
    const q = knowledge.byId.get(req.params.id);
    if (!q) return res.status(404).json({ error: 'unknown question' });
    const b = req.body?.budget || {};
    const clamp = (x, fallback, max) => { const n = Number(x); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : fallback; };
    const budget = createBudget({ limitUsd: clamp(b.limitUsd, defaultBudget.limitUsd, 10), perCallMaxUsd: clamp(b.perCallMaxUsd, defaultBudget.perCallMaxUsd, 1), spent: clamp(b.spent, 0, 10) });
    const ledger = createLedger(null);
    try {
      const r = await playRound({ question: knowledge.publicView(q), baseUrl: selfUrl(req), budget, payer, ledger, threshold: Number(req.body?.threshold || 0.8) });
      const analysis = analyze(q.surface, knowledge.fullFacts(q));
      const c = coach(q, analysis, r.verdict);
      res.json({ transcript: r.transcript, verdict: r.verdict, confidence: r.confidence, spentUsd: r.spentUsd, correct: c.correct, truth: q.truth, budget: budget.state(), ledger: ledger.all() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- The four paid checks ----
  const paid = (kind, fn) => [paywall.charge(EVIDENCE_PRICES_USD[kind], { simulation: 'Transaction simulation', addresses: 'Address reputation', programs: 'Program / mint check', domain: 'Domain verification' }[kind]), async (req, res) => {
    try { res.json(await fn(req.body || {})); }
    catch (e) { res.status(400).json({ error: e.message }); }
  }];
  app.post('/check/address', ...paid('addresses', (b) => checks.address(b)));
  app.post('/check/simulate', ...paid('simulation', (b) => checks.simulate(b)));
  app.post('/check/program', ...paid('programs', (b) => checks.program(b)));
  app.post('/check/domain', ...paid('domain', (b) => checks.domain(b.domain ? b : { domain: knowledge.byId.get(b.questionId)?.surface.domain })));

  return { app, knowledge, paywall, defaultBudget };
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
  console.log(`Scam or Safe  →  ${baseUrl}\n  ${knowledge.questions.length} questions · payment scheme ${paywall.scheme} · check prices ${JSON.stringify(EVIDENCE_PRICES_USD)}`);
}
