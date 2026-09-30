// Starts a real server: 402 → pay → 200 → replay rejected; the agent loop in three situations (free is enough, evidence must be bought, budget exhausted).
import test from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../server/index.js';
import { playRound, buy } from '../agent/loop.js';
import { createBudget } from '../agent/budget.js';
import { createPayer } from '../agent/payer.js';
import { createLedger } from '../server/ledger.js';

const env = { PORT: '0', LEDGER_PATH: '', AGENT_BUDGET_USD: '0.25' };
let srv;
test.before(async () => { srv = await start(env); });
test.after(() => srv.server.close());

test('paid route: 402 without a header, 200 after paying, replaying the same nonce is rejected', async () => {
  const url = `${srv.baseUrl}/check/domain`;
  const r1 = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: 'jup.ag' }) });
  assert.equal(r1.status, 402);
  const quote = await r1.json();
  assert.equal(quote.accepts[0].price, '0.0050');
  const payer = createPayer({ scheme: 'mock' });
  const paid = await payer.pay(quote);
  const r2 = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-payment': paid.header }, body: JSON.stringify({ domain: 'jup.ag' }) });
  assert.equal(r2.status, 200);
  const body = await r2.json();
  assert.equal(body.data.known, true);
  assert.ok(r2.headers.get('x-payment-response'));
  const r3 = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-payment': paid.header }, body: JSON.stringify({ domain: 'jup.ag' }) });
  assert.equal(r3.status, 402);
  assert.equal((await r3.json()).rejected, 'nonce_already_used');
});

test('buy() handles the 402 and returns the data', async () => {
  const r = await buy(`${srv.baseUrl}/check/address`, { address: 'DrA1nMkQ7vXcP4tYzB9nLs2wEfG6hJkR8uVaN3iZ5pWo' }, { payer: createPayer({ scheme: 'mock' }) });
  assert.equal(r.ok, true);
  assert.equal(r.data['DrA1nMkQ7vXcP4tYzB9nLs2wEfG6hJkR8uVaN3iZ5pWo'].reputation, 'drainer');
  assert.ok(r.receiptId);
});

const q = async (id) => (await fetch(`${srv.baseUrl}/api/questions/${id}`)).json();
const run = (question, budget) => playRound({ question, baseUrl: srv.baseUrl, budget, payer: createPayer({ scheme: 'mock' }), ledger: createLedger(null) });

test('q01 unlimited approve: free heuristics suffice, nothing spent', async () => {
  const budget = createBudget({ limitUsd: 0.25 });
  const r = await run(await q('q01'), budget);
  assert.equal(r.verdict, 'scam'); assert.equal(r.spentUsd, 0); assert.equal(budget.spent(), 0);
});

test('q10 honeypot token: invisible for free, scam after buying the program check', async () => {
  const budget = createBudget({ limitUsd: 0.25 });
  const r = await run(await q('q10'), budget);
  assert.equal(r.verdict, 'scam');
  assert.ok(r.spentUsd > 0, 'should have spent money');
  assert.ok(r.transcript.some((s) => s.type === 'bought' && /MOON/.test(s.text)), 'should have checked the MOON mint');
});

test('q31 CPI drain: scam after buying the simulation', async () => {
  const budget = createBudget({ limitUsd: 0.25 });
  const r = await run(await q('q31'), budget);
  assert.equal(r.verdict, 'scam');
  assert.ok(r.transcript.some((s) => s.type === 'bought' && /USDC -1000/.test(s.text)));
});

test('q02 legitimate swap: safe after buying evidence, no false alarm', async () => {
  const budget = createBudget({ limitUsd: 0.25 });
  const r = await run(await q('q02'), budget);
  assert.equal(r.verdict, 'safe');
});

test('budget exhausted: refuses with a reason and answers on the current judgment', async () => {
  const budget = createBudget({ limitUsd: 0.005 });
  const r = await run(await q('q31'), budget);
  const refused = r.transcript.find((s) => s.type === 'refused');
  assert.ok(refused, 'should have a refused step');
  assert.equal(refused.reason, 'budget_exhausted');
  assert.equal(r.spentUsd, 0);
});

test('answer endpoint: coaches a wrong answer', async () => {
  const r = await (await fetch(`${srv.baseUrl}/api/questions/q17/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ who: 'human', answer: 'scam' }) })).json();
  assert.equal(r.correct, false); assert.equal(r.truth, 'safe');
  assert.match(r.headline, /rejected a legitimate transaction/);
  assert.ok(r.sections.some((s) => s.title === 'Why it is safe' && s.items.length));
  assert.ok(r.cases.some((c) => c.id === 'F4'));
});
