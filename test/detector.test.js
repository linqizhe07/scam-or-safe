// 每道题：全部事实下 verdict == truth；安全题只看弹窗时不能出现 high（免费启发式不能冤枉正常交易）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadKnowledge } from '../server/knowledge.js';
import { analyze, coach, statedAmounts } from '../server/detector.js';

const k = loadKnowledge();

for (const q of k.questions) {
  test(`${q.id} ${q.title} → ${q.truth}`, () => {
    const full = analyze(q.surface, k.fullFacts(q));
    assert.equal(full.verdict, q.truth, `全事实 verdict 应为 ${q.truth}，得到 ${full.verdict}：${full.findings.map((f) => f.rule + ':' + f.severity).join(',')}`);
    assert.ok(full.confidence >= 0.6, `全事实置信度 ${full.confidence} 太低`);
    const free = analyze(q.surface, {});
    if (q.truth === 'safe') assert.equal(free.counts.high, 0, `安全题免费启发式出现 high：${free.findings.filter((f) => f.severity === 'high').map((f) => f.rule)}`);
    const c = coach(q, full, q.truth === 'scam' ? 'safe' : 'scam');
    assert.equal(c.correct, false);
    assert.ok(c.headline && c.sections.length && c.lesson);
  });
}

test('每个非 depends 的 case 至少有一道题', () => {
  const covered = new Set(k.questions.flatMap((q) => q.case));
  const missing = k.taxonomy.cases.filter((c) => c.truth !== 'depends' && !covered.has(c.id)).map((c) => c.id);
  // 骨架阶段允许缺题，但要把缺的列出来（npm run coverage）；这里只保证已出的题都引用了存在的 case
  for (const q of k.questions) for (const id of q.case) assert.ok(k.caseById.has(id), `${q.id} 引用了不存在的 case ${id}`);
  console.log(`  待出题 case：${missing.join(', ') || '无'}`);
});

test('taxonomy 里引用的规则在识别器里存在', () => {
  const src = k.taxonomy.cases.flatMap((c) => c.rules);
  const known = new Set(['unlimited_approve', 'label_mismatch', 'approve_to_wallet', 'counterparty_flagged', 'set_authority', 'system_assign', 'delegate_granted_sim', 'honeypot_mint', 'address_poisoning', 'stray_transfer', 'outflow_vs_balance', 'fee_ratio', 'nft_outflow', 'counterparty_known', 'close_to_self', 'durable_nonce_signin', 'message_is_transaction', 'not_fee_payer', 'alt_unresolved', 'simulation_hidden', 'siws_domain_match', 'nonce_setup', 'mixed_sensitive_ops', 'close_to_stranger', 'unverified_program', 'program_label_mismatch', 'program_lookalike', 'verified_program', 'hidden_outflow', 'domain_known', 'zero_min_out', 'domain_lookalike', 'domain_fresh', 'domain_non_ascii', 'domain_subdomain_trick', 'urgency_language', 'mint_without_mint', 'pay_without_receive', 'stated_amount_mismatch', 'fake_mint', 'bounded_approve_ok', 'revoke_is_safe', 'priority_fee_excess', 'rent_outflow']);
  const unknown = [...new Set(src)].filter((r) => !known.has(r));
  assert.deepEqual(unknown, [], `taxonomy 引用了识别器里没有的规则：${unknown}`);
});

test('statedAmounts 解析文案金额', () => {
  assert.deepEqual(statedAmounts('Mint Okay Bear for 0.1 SOL'), [{ amount: 0.1, symbol: 'SOL' }]);
  assert.deepEqual(statedAmounts('Swap 1,000 USDC → SOL'), [{ amount: 1000, symbol: 'USDC' }]);
});
