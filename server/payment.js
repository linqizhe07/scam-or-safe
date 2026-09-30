// The 402 paywall layer. Shaped after x402 V2's PAYMENT-REQUIRED / X-PAYMENT so the whole layer can later be swapped for @x402/express + @x402/svm.
//
//   scheme = mock   : no chain. The 402 quote carries a nonce; the payer puts { nonce, amount, payer } in the X-Payment header,
//                     and the server only checks that the nonce is unused and the amount is enough. Good for running the game locally.
//   scheme = solana : the proof in X-Payment is a devnet transaction signature; the server confirms receipt with live.verifySolTransfer. Untested.
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

  // Express middleware: paywall.charge(0.02, 'Transaction simulation')
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
