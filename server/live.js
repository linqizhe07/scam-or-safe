// devnet 直连骨架。所有函数都是动态加载 @solana/web3.js，没装也不影响 mock 模式。
// ⚠ 这一层还没有在 devnet 上跑过（写骨架时沙盒没有网络）。接 solana 方案的第一件事是把这四个函数各跑一遍。

async function web3() {
  try { return await import('@solana/web3.js'); }
  catch { throw new Error('需要 @solana/web3.js：npm i @solana/web3.js'); }
}

// 把 base64 交易丢给 devnet 模拟，返回 logs / err / unitsConsumed。余额差要自己算（accounts 配置 + pre/post）。
export async function simulateBase64(txBase64, rpc) {
  const { Connection, VersionedTransaction } = await web3();
  const conn = new Connection(rpc, 'confirmed');
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
  const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  return { ok: !r.value.err, error: r.value.err ? JSON.stringify(r.value.err) : null, logs: r.value.logs, unitsConsumed: r.value.unitsConsumed, source: 'devnet' };
}

// 程序体检：是不是可升级程序、升级权限是谁。ProgramData 布局：4 字节枚举(3) + 8 字节 slot + 1 字节 option + 32 字节 authority。
export async function programInfo(address, rpc) {
  const { Connection, PublicKey } = await web3();
  const conn = new Connection(rpc, 'confirmed');
  const pk = new PublicKey(address);
  const info = await conn.getAccountInfo(pk);
  if (!info) return { address, exists: false, source: 'devnet' };
  const UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
  const out = { address, kind: info.executable ? 'program' : 'account', owner: info.owner.toBase58(), verified: false, source: 'devnet' };
  if (info.executable && info.owner.toBase58() === UPGRADEABLE) {
    const [programData] = PublicKey.findProgramAddressSync([pk.toBuffer()], new PublicKey(UPGRADEABLE));
    const pd = await conn.getAccountInfo(programData);
    if (pd) {
      const hasAuthority = pd.data[12] === 1;
      out.upgradeable = hasAuthority;
      out.upgradeAuthority = hasAuthority ? new PublicKey(pd.data.subarray(13, 45)).toBase58() : null;
      out.upgradeAuthorityKind = hasAuthority ? 'unknown' : 'none';
      out.lastDeploySlot = Number(pd.data.readBigUInt64LE(4));
    }
  }
  return out;
}

// 收款方核验一笔 SOL 转账：payTo 的余额在这笔交易里至少增加了 minLamports。
export async function verifySolTransfer({ signature, payTo, minLamports, rpc }) {
  const { Connection } = await web3();
  const conn = new Connection(rpc, 'confirmed');
  const tx = await conn.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  if (!tx || tx.meta?.err) return { ok: false, reason: tx ? 'tx_failed' : 'tx_not_found' };
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey.toBase58()));
  const i = keys.indexOf(payTo);
  if (i < 0) return { ok: false, reason: 'payee_not_in_tx' };
  const delta = tx.meta.postBalances[i] - tx.meta.preBalances[i];
  return delta >= minLamports ? { ok: true, delta } : { ok: false, reason: 'amount_too_low', delta };
}

// agent 侧付款：从 keypair 转 lamports 到 payTo，memo 里写 nonce，返回签名。
export async function sendSolTransfer({ keypairSecret, to, lamports, memo, rpc }) {
  const { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } = await web3();
  const conn = new Connection(rpc, 'confirmed');
  const secret = keypairSecret.trim().startsWith('[') ? Uint8Array.from(JSON.parse(keypairSecret)) : (await import('bs58')).default.decode(keypairSecret);
  const kp = Keypair.fromSecretKey(secret);
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(to), lamports }));
  if (memo) tx.add(new TransactionInstruction({ keys: [], programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), data: Buffer.from(memo) }));
  return sendAndConfirmTransaction(conn, tx, [kp]);
}
