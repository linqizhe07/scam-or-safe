// 付款适配器：拿到 402 报价，返回 X-Payment 头的值。
//   mock   ：把 nonce / 金额 / 付款人打包，服务端只核对 nonce。
//   solana ：真的在 devnet 转一笔 SOL，把签名当 proof。未验证（见 server/live.js）。
// 以后换成 x402：这个文件整个换成 @x402/fetch 的 wrapFetchWithPayment，agent/loop.js 的 buy() 不用改。
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
