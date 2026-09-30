// 打印 edge case 覆盖表：哪些 case 有题、哪些待出题。
import { loadKnowledge } from '../server/knowledge.js';
const k = loadKnowledge();
const byCase = new Map();
for (const q of k.questions) for (const c of q.case) byCase.set(c, [...(byCase.get(c) || []), q.id]);
let cat = '';
const rows = [];
for (const c of k.taxonomy.cases) {
  const qs = byCase.get(c.id) || [];
  rows.push({ case: c.id, 类别: c.id[0] === cat ? '' : (cat = c.id[0], k.taxonomy.categories[cat].split('：')[0]), 名称: c.name, 答案: c.truth, 证据: c.evidence.join('+'), 题: qs.join(' ') || (c.truth === 'depends' ? '(depends)' : '待出题') });
}
console.table(rows);
const todo = k.taxonomy.cases.filter((c) => !byCase.has(c.id));
console.log(`${k.taxonomy.cases.length} 个 case，${k.taxonomy.cases.length - todo.length} 个有题，${todo.filter((c) => c.truth !== 'depends').length} 个待出题，${todo.filter((c) => c.truth === 'depends').length} 个 depends（先定规则再出题）。`);
console.log('待出题：', todo.filter((c) => c.truth !== 'depends').map((c) => `${c.id} ${c.name}`).join('；'));
console.log('depends：', todo.filter((c) => c.truth === 'depends').map((c) => `${c.id} ${c.name}`).join('；'));
