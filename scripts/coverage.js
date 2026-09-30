// Prints the edge-case coverage table: which cases have questions and which still need one.
import { loadKnowledge } from '../server/knowledge.js';
const k = loadKnowledge();
const byCase = new Map();
for (const q of k.questions) for (const c of q.case) byCase.set(c, [...(byCase.get(c) || []), q.id]);
let cat = '';
const rows = [];
for (const c of k.taxonomy.cases) {
  const qs = byCase.get(c.id) || [];
  rows.push({ case: c.id, category: c.id[0] === cat ? '' : (cat = c.id[0], k.taxonomy.categories[cat].split(': ')[0]), name: c.name, truth: c.truth, evidence: c.evidence.join('+'), questions: qs.join(' ') || (c.truth === 'depends' ? '(depends)' : 'TODO') });
}
console.table(rows);
const todo = k.taxonomy.cases.filter((c) => !byCase.has(c.id));
console.log(`${k.taxonomy.cases.length} cases, ${k.taxonomy.cases.length - todo.length} with questions, ${todo.filter((c) => c.truth !== 'depends').length} still need one, ${todo.filter((c) => c.truth === 'depends').length} depends (settle the rule first, then write the question).`);
console.log('Need questions:', todo.filter((c) => c.truth !== 'depends').map((c) => `${c.id} ${c.name}`).join('; '));
console.log('depends:', todo.filter((c) => c.truth === 'depends').map((c) => `${c.id} ${c.name}`).join('; '));
