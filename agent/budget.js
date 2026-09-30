// 预算计数器：agent 花钱前先 reserve，被拒就带着理由停下。刻意做成最简：总额 + 单笔上限 + 花费历史。
// （接 agentpay 的话，这一层换成 MandateWallet 的策略闸，接口不变。）
export function createBudget({ limitUsd = 0.25, perCallMaxUsd = 0.05 } = {}) {
  let spent = 0;
  const history = [];
  const round = (x) => Number(x.toFixed(4));
  return {
    limitUsd, perCallMaxUsd,
    reserve(priceUsd, why = '') {
      if (priceUsd > perCallMaxUsd) return { ok: false, reason: 'per_call_max', detail: `单笔 $${priceUsd} 超过上限 $${perCallMaxUsd}`, remaining: round(limitUsd - spent) };
      if (spent + priceUsd > limitUsd + 1e-9) return { ok: false, reason: 'budget_exhausted', detail: `剩余 $${round(limitUsd - spent)}，不够付 $${priceUsd}`, remaining: round(limitUsd - spent) };
      spent = round(spent + priceUsd);
      history.push({ priceUsd, why, ts: Date.now() });
      return { ok: true, remaining: round(limitUsd - spent) };
    },
    refund(priceUsd) { spent = round(Math.max(0, spent - priceUsd)); },
    spent: () => spent,
    remaining: () => round(limitUsd - spent),
    state: () => ({ limitUsd, perCallMaxUsd, spent, remaining: round(limitUsd - spent), calls: history.length }),
    reset() { spent = 0; history.length = 0; },
  };
}
