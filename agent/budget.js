// Budget counter: the agent reserves before spending, and a refusal comes with a reason. Deliberately minimal: a total, a per-call cap, and spend history.
// (When wired to agentpay, this layer becomes MandateWallet's policy gate; the interface stays the same.)
export function createBudget({ limitUsd = 0.25, perCallMaxUsd = 0.05 } = {}) {
  let spent = 0;
  const history = [];
  const round = (x) => Number(x.toFixed(4));
  return {
    limitUsd, perCallMaxUsd,
    reserve(priceUsd, why = '') {
      if (priceUsd > perCallMaxUsd) return { ok: false, reason: 'per_call_max', detail: `a single call of $${priceUsd} exceeds the cap of $${perCallMaxUsd}`, remaining: round(limitUsd - spent) };
      if (spent + priceUsd > limitUsd + 1e-9) return { ok: false, reason: 'budget_exhausted', detail: `$${round(limitUsd - spent)} left, not enough for $${priceUsd}`, remaining: round(limitUsd - spent) };
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
