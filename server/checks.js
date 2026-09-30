// The four paid checks. Each returns { kind, input, data, source }; data has exactly the shape the detector's facts.<kind> expects.
import * as live from './live.js';

export function createChecks(knowledge, { liveMode = false, rpc } = {}) {
  return {
    // 1. Address reputation
    async address({ address }) {
      if (!address) throw new Error('address required');
      const hit = knowledge.addressInfo(address);
      return { kind: 'addresses', input: { address }, data: { [address]: hit || { reputation: 'unknown', firstSeenDaysAgo: null, notes: 'address not in the knowledge base' } }, source: hit ? 'knowledge' : 'none' };
    },
    // 2. Transaction simulation: bank questions are looked up by questionId; LIVE mode accepts a base64 transaction and sends it to devnet
    async simulate({ questionId, transactionBase64 }) {
      if (questionId) {
        const sim = knowledge.simulationOf(questionId);
        if (!sim) throw new Error('unknown question');
        return { kind: 'simulation', input: { questionId }, data: sim, source: 'knowledge' };
      }
      if (transactionBase64 && liveMode) return { kind: 'simulation', input: { transactionBase64: '…' }, data: await live.simulateBase64(transactionBase64, rpc), source: 'devnet' };
      throw new Error('questionId required (or transactionBase64 with LIVE=1)');
    },
    // 3. Program / mint check
    async program({ address }) {
      if (!address) throw new Error('address required');
      const hit = knowledge.programInfo(address);
      if (hit) return { kind: 'programs', input: { address }, data: { [address]: hit }, source: 'knowledge' };
      if (liveMode) return { kind: 'programs', input: { address }, data: { [address]: await live.programInfo(address, rpc) }, source: 'devnet' };
      return { kind: 'programs', input: { address }, data: { [address]: { kind: 'unknown', verified: false, notes: 'program / mint not in the knowledge base' } }, source: 'none' };
    },
    // 4. Domain verification
    async domain({ domain }) {
      if (!domain) throw new Error('domain required');
      const info = knowledge.domainInfo(domain);
      return { kind: 'domain', input: { domain }, data: info, source: info.source };
    },
  };
}
