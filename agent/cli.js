// Runs the whole question bank from the command line: node agent/cli.js [--base http://localhost:4100] [--budget 0.25]
import { playRound } from './loop.js';
import { createBudget } from './budget.js';
import { createPayer } from './payer.js';
import { createLedger } from '../server/ledger.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : [])).filter((x) => x.length));
const baseUrl = args.base || process.env.BASE_URL || 'http://127.0.0.1:4100';
const budget = createBudget({ limitUsd: Number(args.budget || process.env.AGENT_BUDGET_USD || 0.25), perCallMaxUsd: Number(process.env.AGENT_PER_CALL_MAX_USD || 0.05) });
const payer = createPayer({ scheme: process.env.PAYMENT_SCHEME || 'mock', keypairSecret: process.env.AGENT_KEYPAIR, rpc: process.env.SOLANA_RPC });
const ledger = createLedger(args.ledger || 'out/agent-cli-ledger.jsonl');

const list = await (await fetch(`${baseUrl}/api/questions`)).json();
const rows = [];
for (const { id } of list) {
  const question = await (await fetch(`${baseUrl}/api/questions/${id}`)).json();
  const r = await playRound({ question, baseUrl, budget, payer, ledger, log: (s) => console.log(`  [${s.type}] ${s.text}`) });
  const graded = await (await fetch(`${baseUrl}/api/questions/${id}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ who: 'agent', answer: r.verdict }) })).json();
  rows.push({ id, title: question.title, answer: r.verdict, truth: graded.truth, correct: graded.correct, confidence: r.confidence, spent: r.spentUsd });
}
console.log('\nResults:');
console.table(rows);
const right = rows.filter((r) => r.correct).length;
console.log(`${right}/${rows.length} correct, spent $${budget.spent().toFixed(3)} in total (budget $${budget.limitUsd})`);
