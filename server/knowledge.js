// Loads the question bank and the ground truth. The four paid checks read from here; with LIVE=1, misses fall through to devnet (live.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, '..', 'data');
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));

export function loadKnowledge() {
  const taxonomy = read('taxonomy.json');
  const bank = read('questions.json');
  const kb = read('knowledge.json');
  const questions = bank.questions.map((q, i) => ({ ...q, index: i, surface: { ...bank.defaults, ...q.surface } }));
  const byId = new Map(questions.map((q) => [q.id, q]));
  const caseById = new Map(taxonomy.cases.map((c) => [c.id, c]));

  function domainInfo(name) {
    if (!name) return null;
    if (kb.domains[name]) return { ...kb.domains[name], name, source: 'knowledge' };
    return { ...domainHeuristics(name, kb.knownDomains), name, source: 'heuristic' };
  }

  return {
    taxonomy, kb, questions, byId, caseById,
    // What the player / agent can see: no truth, simulation or lesson
    publicView(q) { return { id: q.id, index: q.index, total: questions.length, title: q.title, surface: q.surface }; },
    // For coaching: all the facts
    fullFacts(q) {
      return { simulation: q.simulation, addresses: kb.addresses, programs: kb.programs, domain: q.surface.domain ? domainInfo(q.surface.domain) : undefined };
    },
    addressInfo(a) { return kb.addresses[a] ? { ...kb.addresses[a], address: a, source: 'knowledge' } : null; },
    programInfo(a) { return kb.programs[a] ? { ...kb.programs[a], address: a, source: 'knowledge' } : null; },
    domainInfo,
    simulationOf(id) { return byId.get(id)?.simulation ?? null; },
  };
}

// Domains not in the knowledge base: what can be inferred for free (subdomain trick, non-ASCII, one or two characters off a known domain, embedded brand word)
export function domainHeuristics(name, knownDomains = []) {
  const parts = name.split('.');
  const root = parts.length <= 2 ? name : parts.slice(-2).join('.');
  const out = { known: knownDomains.includes(name) || knownDomains.includes(root) && name.endsWith('.' + root), registeredDaysAgo: null };
  if (out.known) { out.officialOf = root; return out; }
  if (/[^\x00-\x7F]/.test(name)) { const ascii = name.normalize('NFKD').replace(/[^\x00-\x7F]/g, 'u'); const hit = knownDomains.find((k) => k === ascii); return { ...out, lookalikeOf: hit || ascii, lookalikeKind: 'homoglyph' }; }
  const embedded = knownDomains.find((k) => name !== k && !name.endsWith('.' + k) && name.includes(k));
  if (embedded) return { ...out, lookalikeOf: embedded, lookalikeKind: 'subdomain', notes: `The root domain is ${root}.` };
  const brand = knownDomains.find((k) => { const b = k.split('.')[0]; return b.length >= 3 && root.split('.')[0].includes(b); });
  if (brand) return { ...out, lookalikeOf: brand, lookalikeKind: 'brand' };
  const typo = knownDomains.find((k) => levenshtein(root, k) <= 2);
  if (typo) return { ...out, lookalikeOf: typo, lookalikeKind: 'typo' };
  return out;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length; const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
