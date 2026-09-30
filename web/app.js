// Game page: fetch a question → countdown → Scam / Safe → the detector explains; agent panel + ledger on the right.
const $ = (s) => document.querySelector(s);
const short = (a) => (typeof a === 'string' && a.length > 14 ? `${a.slice(0, 4)}…${a.slice(-4)}` : String(a));
const api = async (url, body) => { const r = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined); return r.json(); };

const ROUND_SECONDS = 30;
let questions = [], cursor = 0, current = null, timer = null, remaining = ROUND_SECONDS, answered = false, prices = {};

async function boot() {
  const state = await api('/api/state');
  prices = state.prices; renderState(state);
  questions = await api('/api/questions');
  cursor = Math.max(0, questions.findIndex((q) => !q.answered?.human));
  if (cursor < 0) cursor = 0;
  loadQuestion();
}

async function loadQuestion() {
  const q = questions[cursor];
  if (!q) return finish();
  current = await api(`/api/questions/${q.id}`);
  answered = false;
  $('#card').classList.remove('answered');
  $('#result').hidden = true; $('#actions-after').hidden = true; $('#actions').hidden = false;
  $('#btn-scam').disabled = $('#btn-safe').disabled = false;
  $('#agent-steps').innerHTML = ''; $('#btn-agent').disabled = false;
  renderCard(current);
  startTimer();
}

function renderCard(q) {
  const s = q.surface;
  $('#q-index').textContent = `Question ${q.index + 1} / ${q.total}`;
  $('#q-domain').textContent = s.domain || 'In-wallet action (no website)';
  $('#q-title').textContent = q.title;
  $('#q-prompt').textContent = s.prompt;
  const chips = [];
  chips.push(s.signMode === 'message' ? 'Sign message' : 'Sign transaction');
  if (s.feePayer && s.feePayer !== s.user) chips.push({ t: `fee payer: ${short(s.feePayer)} (not you)`, w: true });
  if (s.durableNonce) chips.push({ t: 'durable nonce', w: true });
  if (s.addressLookupTables?.length) chips.push({ t: `references ${s.addressLookupTables.length} lookup table(s)`, w: true });
  if (s.walletSimulation && s.walletSimulation !== 'ok') chips.push({ t: `wallet simulation ${s.walletSimulation === 'failed' ? 'failed' : 'unavailable'}`, w: true });
  $('#q-chips').innerHTML = chips.map((c) => typeof c === 'string' ? `<span class="chip">${c}</span>` : `<span class="chip ${c.w ? 'warn' : ''}">${c.t}</span>`).join('');
  const list = $('#q-instructions'); list.innerHTML = '';
  for (const ix of s.instructions || []) {
    const li = document.createElement('li');
    const acc = Object.entries(ix.accounts || {}).map(([k, v]) => `${k}=${v && typeof v === 'object' ? `<span class="unres">[lookup ${short(v.lookup)} #${v.index}]</span>` : nameFor(v, s)}`).join(' ');
    const args = Object.entries(ix.args || {}).filter(([k]) => !['decimals'].includes(k)).map(([k, v]) => `${k}=${typeof v === 'number' ? v.toLocaleString() : v}`).join(' ');
    li.innerHTML = `<span class="type">${ix.type}</span> <span class="prog">${ix.programLabel || short(ix.program)}</span>${ix.label ? ` <span class="label">“${ix.label}”</span>` : ''}<br><span class="kv">${acc}${args ? ' · ' + args : ''}</span>`;
    list.appendChild(li);
  }
  const msg = $('#q-message');
  if (s.signMode === 'message' && s.message) { msg.hidden = false; msg.textContent = s.message.type === 'siws' ? Object.entries(s.message).filter(([k]) => k !== 'type').map(([k, v]) => `${k}: ${v}`).join('\n') : `bytes: ${s.message.bytesHex}\nwallet hint: ${s.message.decoded || ''}`; }
  else msg.hidden = true;
  const b = s.balances || {};
  $('#q-balances').textContent = `Your balance: ${b.sol ?? 0} SOL` + Object.entries(b.tokens || {}).map(([k, v]) => ` · ${v} ${k}`).join('') + (Object.keys(s.addressBook || {}).length ? ` · Address book: ${Object.entries(s.addressBook).map(([n, a]) => `${n} ${short(a)}`).join(', ')}` : '');
}
function nameFor(v, s) {
  if (typeof v !== 'string') return String(v);
  if (v === s.user) return '<b>you</b>';
  if ((s.userAccounts || []).includes(v)) return `<b>your account</b> (${short(v)})`;
  const book = Object.entries(s.addressBook || {}).find(([, a]) => a === v);
  if (book) return `<b>${book[0]}</b> (${short(v)})`;
  return v.length > 20 ? `${v.slice(0, 6)}…${v.slice(-6)}` : v;
}

function startTimer() {
  clearInterval(timer); remaining = ROUND_SECONDS; tick();
  timer = setInterval(() => { remaining--; tick(); if (remaining <= 0) { clearInterval(timer); if (!answered) answer('timeout'); } }, 1000);
}
function tick() { $('#timer-text').textContent = remaining; $('#timer-arc').style.strokeDashoffset = 106.8 * (1 - remaining / ROUND_SECONDS); }

async function answer(choice) {
  if (answered) return; answered = true; clearInterval(timer);
  $('#btn-scam').disabled = $('#btn-safe').disabled = true; $('#card').classList.add('answered');
  const r = await api(`/api/questions/${current.id}/answer`, { who: 'human', answer: choice });
  questions[cursor].answered = { ...(questions[cursor].answered || {}), human: { answer: choice, correct: r.correct } };
  renderResult(r); renderScores(r.scores);
  $('#actions').hidden = true; $('#actions-after').hidden = false;
}

function renderResult(r) {
  const box = $('#result'); box.hidden = false;
  $('#r-headline').textContent = r.headline;
  $('#r-verdict').textContent = r.truth === 'scam' ? 'Truth: Scam' : 'Truth: Safe'; $('#r-verdict').className = `pill ${r.truth}`;
  $('#r-sections').innerHTML = r.sections.map((s) => `<div class="section"><h3>${s.title}</h3>${s.items.map((f) => `<div class="finding ${f.severity}"><b>${f.title}</b><div class="detail">${f.detail}</div>${f.howToSpot ? `<div class="spot">How to spot it: ${f.howToSpot}</div>` : ''}<div class="ev">${f.evidence}</div></div>`).join('') || '<div class="finding low">(none)</div>'}</div>`).join('');
  $('#r-lesson').textContent = r.lesson;
  $('#r-cases').innerHTML = 'This question covers: ' + r.cases.map((c) => `<span title="${c.trick}">${c.id} ${c.name}</span>`).join('');
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function runAgent() {
  $('#btn-agent').disabled = true;
  const steps = $('#agent-steps'); steps.innerHTML = '';
  const r = await api(`/api/questions/${current.id}/agent`, {});
  if (r.error) { steps.innerHTML = `<li class="error">${r.error}</li>`; return; }
  for (const st of r.transcript) {
    await new Promise((res) => setTimeout(res, 350));
    const li = document.createElement('li'); li.className = st.type; li.innerHTML = `<span class="t">${st.type}</span>${st.text}`; steps.appendChild(li); li.scrollIntoView({ block: 'nearest' });
  }
  const li = document.createElement('li'); li.className = r.correct ? 'bought' : 'refused'; li.innerHTML = `<span class="t">result</span>${r.correct ? 'Correct' : 'Wrong'} (truth: ${r.truth === 'scam' ? 'Scam' : 'Safe'}), $${r.spentUsd.toFixed(3)} spent this round`; steps.appendChild(li);
  questions[cursor].answered = { ...(questions[cursor].answered || {}), agent: { answer: r.verdict, correct: r.correct } };
  renderScores(r.scores); renderBudget(r.budget); renderLedger((await api('/api/state')).ledger);
}

function renderState(s) { renderScores(s.scores); renderBudget(s.budget); renderLedger(s.ledger); }
function renderScores(sc) { $('#human-score').textContent = `${sc.human.right} / ${sc.human.right + sc.human.wrong}`; $('#agent-score').textContent = `${sc.agent.right} / ${sc.agent.right + sc.agent.wrong}`; }
function renderBudget(b) { $('#budget-text').textContent = `$${b.spent.toFixed(3)} / $${b.limitUsd}`; $('#budget-bar').style.width = `${Math.min(100, (b.spent / b.limitUsd) * 100)}%`; $('#budget-bar').style.background = b.remaining <= 0 ? 'var(--red)' : 'var(--amber)'; }
function renderLedger(rows) {
  const tb = $('#ledger tbody'); tb.innerHTML = '';
  for (const e of rows.slice().reverse()) { const tr = document.createElement('tr'); tr.innerHTML = `<td>${e.question}</td><td>${e.route.replace('/check/', '')}</td><td>$${e.priceUsd}</td><td class="${e.status}">${e.status}</td><td title="${e.why || ''}">${(e.why || e.reason || '').slice(0, 40)}</td>`; tb.appendChild(tr); }
  $('#ledger-count').textContent = rows.length ? `(${rows.length} entries)` : '(empty)';
}
function finish() {
  $('#card').innerHTML = `<h1>All ${questions.length} questions done</h1><p>You ${$('#human-score').textContent}, agent ${$('#agent-score').textContent}. Hit “Reset” in the top right to play another round.</p>`;
}

$('#btn-scam').onclick = () => answer('scam');
$('#btn-safe').onclick = () => answer('safe');
$('#btn-next').onclick = () => { cursor++; loadQuestion(); };
$('#btn-agent').onclick = runAgent;
$('#reset').onclick = async () => { await api('/api/reset', {}); location.reload(); };
document.addEventListener('keydown', (e) => { if (answered) { if (e.key === 'Enter' || e.key === ' ') $('#btn-next').click(); return; } if (e.key === 'ArrowLeft' || e.key === 's') answer('scam'); if (e.key === 'ArrowRight' || e.key === 'f') answer('safe'); if (e.key === 'a') runAgent(); });
boot();
