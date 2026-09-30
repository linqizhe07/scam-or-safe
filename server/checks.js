// 四条付费检查。每条返回 { kind, input, data, source }，data 的形状就是 detector 的 facts.<kind> 要的。
import * as live from './live.js';

export function createChecks(knowledge, { liveMode = false, rpc } = {}) {
  return {
    // 1. 地址信誉
    async address({ address }) {
      if (!address) throw new Error('address required');
      const hit = knowledge.addressInfo(address);
      return { kind: 'addresses', input: { address }, data: { [address]: hit || { reputation: 'unknown', firstSeenDaysAgo: null, notes: '知识库里没有这个地址' } }, source: hit ? 'knowledge' : 'none' };
    },
    // 2. 交易模拟：题库里的题按 questionId 取；LIVE 模式接收 base64 交易去 devnet
    async simulate({ questionId, transactionBase64 }) {
      if (questionId) {
        const sim = knowledge.simulationOf(questionId);
        if (!sim) throw new Error('unknown question');
        return { kind: 'simulation', input: { questionId }, data: sim, source: 'knowledge' };
      }
      if (transactionBase64 && liveMode) return { kind: 'simulation', input: { transactionBase64: '…' }, data: await live.simulateBase64(transactionBase64, rpc), source: 'devnet' };
      throw new Error('questionId required (or transactionBase64 with LIVE=1)');
    },
    // 3. 程序 / mint 体检
    async program({ address }) {
      if (!address) throw new Error('address required');
      const hit = knowledge.programInfo(address);
      if (hit) return { kind: 'programs', input: { address }, data: { [address]: hit }, source: 'knowledge' };
      if (liveMode) return { kind: 'programs', input: { address }, data: { [address]: await live.programInfo(address, rpc) }, source: 'devnet' };
      return { kind: 'programs', input: { address }, data: { [address]: { kind: 'unknown', verified: false, notes: '知识库里没有这个程序 / mint' } }, source: 'none' };
    },
    // 4. 域名核验
    async domain({ domain }) {
      if (!domain) throw new Error('domain required');
      const info = knowledge.domainInfo(domain);
      return { kind: 'domain', input: { domain }, data: info, source: info.source };
    },
  };
}
