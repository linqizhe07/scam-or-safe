// 402 收费层。形状照着 x402 V2 的 PAYMENT-REQUIRED / X-PAYMENT 来，方便以后整层换成 @x402/express + @x402/svm。
//
//   scheme = mock   ：没有链。402 报价里带一个 nonce，付款方把 { nonce, amount, payer } 放进 X-Payment 头，
//                     服务端只核对 nonce 未用过、金额够。适合本地跑游戏。
//   scheme = solana ：X-Payment 里的 proof 是 devnet 交易签名，服务端用 live.verifySolTransfer 核对到账。未验证。
import crypto from 'node:crypto';
import * as live from './live.js';

export function createPaywall({ scheme = 'mock', payTo, network = 'solana:devnet', asset = 'USDC', solUsd = 150, rpc, timeoutSeconds = 120, log = () => {} } = {}) {
  const pending = new Map(); // nonce -> { price, resource, expiresAt }
  const used = new Map();    // nonce -> receipt
  const receipts = [];

  const encode = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
  const decode = (s) => { try { return JSON.parse(Buffer.from(s, 'base64').toString('utf8')); } catch { return null; } };

  function quote(req, priceUsd, description) {
    const nonce = crypto.randomBytes(12).toString('hex');
    pending.set(nonce, { price: priceUsd, resource: req.path, expiresAt: Date.now() + timeoutSeconds * 1000 });
    return { x402Version: 2, error: 'payment_required', accepts: [{ scheme, network, asset, price: priceUsd.toFixed(4), priceLamports: scheme === 'solana' ? Math.ceil((priceUsd / solUsd) * 1e9) : undefined, payTo, resource: req.path, description, nonce, maxTimeoutSeconds: timeoutSeconds }] };
  }

  async function verify(header) {
    const p = decode(header);
    if (!p || p.scheme !== scheme) return { ok: false, reason: 'bad_payment_header' };
    const q = pending.get(p.nonce);
    if (!q) return { ok: false, reason: used.has(p.nonce) ? 'nonce_already_used' : 'unknown_nonce' };
    if (q.expiresAt < Date.now()) { pending.delete(p.nonce); return { ok: false, reason: 'quote_expired' }; }
    if (Number(p.amount) + 1e-9 < q.price) return { ok: false, reason: 'amount_too_low' };
    if (scheme === 'solana') {
      const r = await live.verifySolTransfer({ signature: p.proof, payTo, minLamports: Math.ceil((q.price / solUsd) * 1e9), rpc });
      if (!r.ok) return { ok: false, reason: r.reason };
    }
    pending.delete(p.nonce);
    const receipt = { id: crypto.randomUUID(), scheme, nonce: p.nonce, amount: q.price, payer: p.payer || null, proof: p.proof || null, resource: q.resource, ts: new Date().toISOString() };
    used.set(p.nonce, receipt);
    receipts.push(receipt);
    return { ok: true, receipt };
  }

  // Express 中间件：paywall.charge(0.02, '交易模拟')
  function charge(priceUsd, description) {
    return async (req, res, next) => {
      const header = req.get('x-payment');
      if (!header) return res.status(402).json(quote(req, priceUsd, description));
      const v = await verify(header);
      if (!v.ok) { log('payment rejected', v.reason); return res.status(402).json({ ...quote(req, priceUsd, description), rejected: v.reason }); }
      req.payment = v.receipt;
      res.set('X-Payment-Response', encode({ success: true, scheme, receiptId: v.receipt.id, amount: v.receipt.amount }));
      next();
    };
  }

  return { charge, receipts, scheme, payTo, verify };
}
