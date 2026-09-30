// Direct devnet skeleton. Every function loads @solana/web3.js dynamically, so mock mode works without it installed.
// WARNING: this layer has never been run against devnet (the sandbox had no network when the skeleton was written). The first step of wiring up the solana scheme is to run each of these four functions once.

async function web3() {
  try { return await import('@solana/web3.js'); }
  catch { throw new Error('@solana/web3.js is required: npm i @solana/web3.js'); }
}

// Sends a base64 transaction to devnet for simulation; returns logs / err / unitsConsumed. Balance deltas must be computed separately (accounts config + pre/post).
export async function simulateBase64(txBase64, rpc) {
  const { Connection, VersionedTransaction } = await web3();
  const conn = new Connection(rpc, 'confirmed');
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
  const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  return { ok: !r.value.err, error: r.value.err ? JSON.stringify(r.value.err) : null, logs: r.value.logs, unitsConsumed: r.value.unitsConsumed, source: 'devnet' };
}

// Program check: whether it is an upgradeable program and who holds the upgrade authority. ProgramData layout: 4-byte enum (3) + 8-byte slot + 1-byte option + 32-byte authority.
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

// Payee-side verification of a SOL transfer: payTo's balance increased by at least minLamports in this transaction.
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

// Agent-side payment: transfers lamports from the keypair to payTo, writes the nonce in a memo, and returns the signature.
export async function sendSolTransfer({ keypairSecret, to, lamports, memo, rpc }) {
  const { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } = await web3();
  const conn = new Connection(rpc, 'confirmed');
  const secret = keypairSecret.trim().startsWith('[') ? Uint8Array.from(JSON.parse(keypairSecret)) : (await import('bs58')).default.decode(keypairSecret);
  const kp = Keypair.fromSecretKey(secret);
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(to), lamports }));
  if (memo) tx.add(new TransactionInstruction({ keys: [], programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), data: Buffer.from(memo) }));
  return sendAndConfirmTransaction(conn, tx, [kp]);
}
