// 起真实服务：402 → 付款 → 200 → 重放被拒；agent 循环在三种情况下的行为（免费就够、要买证据、预算耗尽）。
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

test('付费路由：无头 402，付款后 200，重放同一 nonce 被拒', async () => {
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

test('buy() 处理 402 并返回数据', async () => {
  const r = await buy(`${srv.baseUrl}/check/address`, { address: 'DrA1nMkQ7vXcP4tYzB9nLs2wEfG6hJkR8uVaN3iZ5pWo' }, { payer: createPayer({ scheme: 'mock' }) });
  assert.equal(r.ok, true);
  assert.equal(r.data['DrA1nMkQ7vXcP4tYzB9nLs2wEfG6hJkR8uVaN3iZ5pWo'].reputation, 'drainer');
  assert.ok(r.receiptId);
});

const q = async (id) => (await fetch(`${srv.baseUrl}/api/questions/${id}`)).json();
const run = (question, budget) => playRound({ question, baseUrl: srv.baseUrl, budget, payer: createPayer({ scheme: 'mock' }), ledger: createLedger(null) });

test('q01 无限授权：免费启发式就够，不花钱', async () => {
  const budget = createBudget({ limitUsd: 0.25 });
  const r = await run(await q('q01'), budget);
  assert.equal(r.verdict, 'scam'); assert.equal(r.spentUsd, 0); assert.equal(budget.spent(), 0);
});

test('q10 蜜罐币：免费看不出，买程序体检后判 scam', async () => {
  const budget = createBudget({ limitUsd: 0.25 });
  const r = await run(await q('q10'), budget);
  assert.equal(r.verdict, 'scam');
  assert.ok(r.spentUsd > 0, '应该花了钱');
  assert.ok(r.transcript.some((s) => s.type === 'bought' && /MOON/.test(s.text)), '应该体检了 MOON mint');
});

test('q31 CPI 掏空：买模拟后判 scam', async () => {
  const budget = createBudget({ limitUsd: 0.25 });
  const r = await run(await q('q31'), budget);
  assert.equal(r.verdict, 'scam');
  assert.ok(r.transcript.some((s) => s.type === 'bought' && /USDC -1000/.test(s.text)));
});

test('q02 正常 swap：买证据后判 safe，且不冤枉', async () => {
  const budget = createBudget({ limitUsd: 0.25 });
  const r = await run(await q('q02'), budget);
  assert.equal(r.verdict, 'safe');
});

test('预算耗尽：拒绝并说明，按现有判断作答', async () => {
  const budget = createBudget({ limitUsd: 0.005 });
  const r = await run(await q('q31'), budget);
  const refused = r.transcript.find((s) => s.type === 'refused');
  assert.ok(refused, '应有 refused 步骤');
  assert.equal(refused.reason, 'budget_exhausted');
  assert.equal(r.spentUsd, 0);
});

test('答题接口：判错时给出解读', async () => {
  const r = await (await fetch(`${srv.baseUrl}/api/questions/q17/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ who: 'human', answer: 'scam' }) })).json();
  assert.equal(r.correct, false); assert.equal(r.truth, 'safe');
  assert.match(r.headline, /拒绝了一笔正常交易/);
  assert.ok(r.sections.some((s) => s.title === '它安全的依据' && s.items.length));
  assert.ok(r.cases.some((c) => c.id === 'F4'));
});
