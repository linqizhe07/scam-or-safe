// Payment adapter: takes a 402 quote and returns the value of the X-Payment header.
//   mock   : packs the nonce / amount / payer; the server only checks the nonce.
//   solana : really transfers SOL on devnet and uses the signature as the proof. Untested (see server/live.js).
// To switch to x402 later: replace this whole file with @x402/fetch's wrapFetchWithPayment; buy() in agent/loop.js stays as is.
import { sendSolTransfer } from '../server/live.js';

export function createPayer({ scheme = 'mock', address = 'AgentMockPayer1111111111111111111111111111', keypairSecret, rpc } = {}) {
  const encode = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
  return {
    scheme, address,
    async pay(quote) {
      const offer = quote.accepts?.find((a) => a.scheme === scheme) || quote.accepts?.[0];
      if (!offer) throw new Error('no acceptable offer in 402');
      if (scheme === 'mock') return { header: encode({ scheme: 'mock', nonce: offer.nonce, amount: offer.price, payer: address }), proof: `mock:${offer.nonce}` };
      if (scheme === 'solana') {
        if (!keypairSecret) throw new Error('AGENT_KEYPAIR required for solana scheme');
        const sig = await sendSolTransfer({ keypairSecret, to: offer.payTo, lamports: offer.priceLamports, memo: offer.nonce, rpc });
        return { header: encode({ scheme: 'solana', nonce: offer.nonce, amount: offer.price, payer: address, proof: sig }), proof: sig };
      }
      throw new Error(`unknown scheme ${scheme}`);
    },
  };
}
