// The 402 paywall layer. Shaped after x402 V2's PAYMENT-REQUIRED / X-PAYMENT so the whole layer can later be swapped for @x402/express + @x402/svm.
//
//   scheme = mock   : no chain. The 402 quote carries a signed nonce (HMAC over price / resource / expiry, so no server-side
//                     memory is needed: a serverless instance that never saw the quote can still verify it). The payer puts
//                     { nonce, amount, payer } in the X-Payment header. Replay protection is best-effort, per process.
//   scheme = solana : the proof in X-Payment is a devnet transaction signature; the server confirms receipt with live.verifySolTransfer. Untested.
import crypto from 'node:crypto';
import * as live from './live.js';

export function createPaywall({ scheme = 'mock', payTo, network = 'solana:devnet', asset = 'USDC', solUsd = 150, rpc, timeoutSeconds = 120, secret = process.env.PAYMENT_SECRET || 'scam-or-safe-dev-secret', log = () => {} } = {}) {
  const used = new Map();    // nonce -> receipt (best-effort replay protection; lives only in this process)
  const receipts = [];

  const encode = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
  const decode = (s) => { try { return JSON.parse(Buffer.from(s, 'base64').toString('utf8')); } catch { return null; } };
  const sign = (body) => crypto.createHmac('sha256', secret).update(body).digest('base64url').slice(0, 32);
  const mintNonce = (price, resource) => { const body = Buffer.from(JSON.stringify({ exp: Date.now() + timeoutSeconds * 1000, price, resource, r: crypto.randomBytes(6).toString('hex') })).toString('base64url'); return `${body}.${sign(body)}`; };
  const openNonce = (nonce) => { const [body, sig] = String(nonce || '').split('.'); if (!body || !sig || sig !== sign(body)) return null; try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; } };

  function quote(req, priceUsd, description) {
    const nonce = mintNonce(priceUsd, req.path);
    return { x402Version: 2, error: 'payment_required', accepts: [{ scheme, network, asset, price: priceUsd.toFixed(4), priceLamports: scheme === 'solana' ? Math.ceil((priceUsd / solUsd) * 1e9) : undefined, payTo, resource: req.path, description, nonce, maxTimeoutSeconds: timeoutSeconds }] };
  }

  async function verify(header) {
    const p = decode(header);
    if (!p || p.scheme !== scheme) return { ok: false, reason: 'bad_payment_header' };
    if (used.has(p.nonce)) return { ok: false, reason: 'nonce_already_used' };
    const q = openNonce(p.nonce);
    if (!q) return { ok: false, reason: 'unknown_nonce' };
    if (q.exp < Date.now()) return { ok: false, reason: 'quote_expired' };
    if (Number(p.amount) + 1e-9 < q.price) return { ok: false, reason: 'amount_too_low' };
    if (scheme === 'solana') {
      const r = await live.verifySolTransfer({ signature: p.proof, payTo, minLamports: Math.ceil((q.price / solUsd) * 1e9), rpc });
      if (!r.ok) return { ok: false, reason: r.reason };
    }
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
