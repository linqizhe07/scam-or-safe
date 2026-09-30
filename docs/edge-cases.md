# Scam edge cases: how to find them, classify them, and turn them into rules and questions

The core of this project is the detector, not the game. A detector is worth as much as the number of scam patterns it has seen, so the edge-case list is the source data (`data/taxonomy.json`); the rules (`server/detector.js`) and the question bank (`data/questions.json`) are both written against it. `npm run coverage` tells you which cases still have no question.

## Six directions for finding edge cases

1. **Label vs. reality**: the popup copy vs. what the instructions actually do. The button says Claim / Mint / Verify / Revoke, but the instruction is Approve / SetAuthority / Transfer. Rules `label_mismatch`, `stated_amount_mismatch`, `mint_without_mint`.
2. **Permission ≠ transfer**: far more than Transfer can take your money. Approve (a delegate allowance), SetAuthority (owner / close authority), Stake Authorize (withdrawer), System Assign (the whole account), AuthorizeNonceAccount, CloseAccount (destination), priority fee (compute budget), rent (creating accounts in bulk). Each one is its own rule.
3. **Where you can't see**: transfers / approvals inside a CPI, accounts hidden in an Address Lookup Table (ALT), durable nonce (signed but not broadcast), a co-signature where you are not the fee payer, a wallet simulation deliberately made to fail, message bytes that are actually a transaction. These are the main source of "can't see it for free, have to buy evidence".
4. **All green but wrong**: the domain is genuine (front-end poisoning), the program is genuine (parameters tampered, minOut = 0), the transaction is normal (the asset you're buying is a honeypot: freeze authority / permanentDelegate / transfer hook / fake mint). The lesson: each layer only vouches for itself.
5. **False positives**: scary words in normal transactions. close / burn / approve / 9 instructions / an upgradeable program / a failed simulation / an unfamiliar Memo program. The game needs enough safe questions and the detector needs green-light rules, otherwise the agent degenerates into "everything is a scam".
6. **Evidence tiers**: every case is tagged with the evidence it needs (free / simulation / addresses / programs / domain). This decides when the agent should spend: if the free rules already produce a high, don't buy; if it can't be seen for free (honeypot, CPI, ALT), buying is mandatory.

## Categories

| Class | Theme | Examples |
|---|---|---|
| A | Approvals and authorities | unlimited Approve, SetAuthority, stake authority, Token-2022 permanentDelegate |
| B | Transfers and recipients | address poisoning, a transfer smuggled into a swap, creating an ATA for a new address (safe) |
| C | Signing and transaction structure | durable nonce, message-as-transaction, non-fee-payer signer, ALT, failed simulation, all-in-one drainer |
| D | Programs and contracts | unverified program, program ID lookalike, CPI drain, hijacked official domain, tampered parameters |
| E | Domains and front ends | brand keyword, homoglyph, subdomain trick, new domain, official secondary domain (safe) |
| F | Airdrops / NFTs / minting | claim-is-Approve, NFT burn that smuggles an authority change, pay and nothing ships, stated price mismatch |
| G | Tokens and trading | fake token, honeypot, zero slippage, complex but normal route (safe) |
| H | Fees and resources | priority-fee drain, rent drain |
| I | Social engineering and context | urgency scripts, "support" DMs |
| J | False positives | a normal transaction whose simulation failed, a transfer with a memo, a genuine Revoke |

Cases with `truth = depends` (platform fee ratio, new domain, mint authority not renounced, ...) are not convicting on their own; set the threshold in a rule first, then write the question.

## Data shapes

**surface** (what is visible in the popup): `domain`, `prompt`, `signMode` (transaction / message), `feePayer`, `durableNonce`, `addressLookupTables`, `walletSimulation` (ok / failed / unavailable), `instructions[]`, `message`, `balances`, `addressBook`, `userAccounts`.

**instruction**: `{ program, programLabel, type, label?, accounts: {…}, args: {…} }`. `label` is the label supplied by the dapp (label-vs-reality mismatches are caught through it). Account slots follow a per-type convention:

| type | accounts | args |
|---|---|---|
| Transfer (System) | from, to | lamports, uiAmount, symbol |
| TransferChecked | source, destination, destinationOwner, owner, mint | amount, uiAmount, symbol, decimals |
| Approve / ApproveChecked | source, delegate, owner, mint | amount (u64 as a string), uiAmount, symbol |
| Revoke | source, owner | |
| SetAuthority | account, currentAuthority, newAuthority | authorityType |
| CloseAccount | account, destination, owner | |
| Authorize (Stake) | stake, authority, newAuthorized | authorityType |
| Assign | account | owner |
| SetComputeUnitLimit / Price | | units / microLamports |
| CreateAssociatedTokenAccount | payer, owner, mint, account | symbol |
| Route / Swap / Deposit (dapp programs) | userSource, userDestination… | inAmount, inSymbol, minOut, outSymbol, outMint |

An account that lives in an ALT and is not yet resolved is written as `{ "lookup": "<table>", "index": n }`.

**facts** (what you pay for): `simulation` (sol / token balance changes, delegates, authorities, feeLamports, rent), `addresses` (reputation: drainer / scam / poisoning / known / program / unknown), `programs` (program: verified, upgradeAuthorityKind, lookalikeOf; mint: freezeAuthorityKind, mintAuthorityKind, extensions, impersonates), `domain` (known / lookalikeOf / lookalikeKind / registeredDaysAgo).

## How to add a case

1. Add an entry to `data/taxonomy.json`: shows / trick / rules / evidence / truth.
2. Add a rule to `server/detector.js` (or confirm an existing rule already covers it). A rule does one thing: recognize one signal from surface + facts and give it a severity (high / medium / low / green), a title, an explanation, how to spot it, and which evidence it relies on.
3. Write the question in `data/questions.json`: what the wallet would show goes in surface, what the simulation would return goes in simulation, and the facts about addresses / programs / domains go in `data/knowledge.json`.
4. `npm test`: with all facts available the verdict must equal truth; a safe question must not produce a high from surface alone.
5. `npm run coverage` to see what is still missing.

## Not done yet

- Cases still waiting for a question: see `npm run coverage` (A5, A7, A8, B2, B5, C6, E6, G4, H2, I2).
- The transactions in the question bank are normalized JSON, not real serialized transactions. The next step is to build real unsigned transactions on devnet with `@solana/web3.js` + `@solana/spl-token`, add a `rawBase64` field, and let the `LIVE=1` simulation route feed them straight to devnet.
- Domain WHOIS / certificate age and on-chain address history are all hard-coded numbers in the knowledge base right now.
