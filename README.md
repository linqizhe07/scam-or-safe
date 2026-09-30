# Scam or Safe

A Solana transaction-spotting game: a transaction shows up on screen the way a wallet popup would present it, and you have 30 seconds to call it **Scam** or **Safe**. When you get it wrong, the detector explains why: the red flags, how to spot them, and which kind of evidence it takes before they become visible. An agent competes against you: it runs the free heuristics first, and when it isn't confident enough it spends within a budget to buy checks (transaction simulation, address reputation, program check, domain verification); when the budget runs out it stops and says why.

The core is the detector (`server/detector.js`) and the edge-case taxonomy behind it (`data/taxonomy.json`, 60 cases). The game and the agent are two ways of using it.

## Run it

```bash
npm install
npm start          # http://127.0.0.1:4100
```

In a second terminal, let the agent play the whole question set (the server has to be running):

```bash
npm run agent
```

```bash
npm test           # detector checked question by question + 402 paywall + agent loop
npm run coverage   # which edge cases have a question and which are still waiting for one
```

Keyboard: `←`/`s` Scam, `→`/`f` Safe, `a` let the agent decide, `Enter` next question.

## Layout

```
data/
  taxonomy.json     edge-case taxonomy (source data): 60 cases, each → rules + evidence source + answer
  knowledge.json    "ground truth" for addresses / programs / mints / domains; the four paid checks look it up
  questions.json    question bank: 33 questions (10 safe / 23 scams), each referencing its cases
server/
  detector.js       detector: 40-odd rules → findings / verdict / confidence / which evidence is still missing; coach() writes the wrong-answer explanation
  checks.js         the four checks: address / simulate / program / domain
  payment.js        402 paywall (shaped after x402 V2): mock scheme (no chain) and a solana scheme skeleton
  knowledge.js      reads the question bank and the fact base; domains not in the knowledge base go through heuristics (subdomain trick / homoglyph / brand keyword / typosquat)
  live.js           devnet skeleton (simulation, program check, payment verification, transfer) — unverified
  ledger.js         JSONL ledger
  index.js          Express entry point (stateless): static page + game API + paid routes + agent trigger
agent/
  loop.js           agent loop: read the question → free heuristics → buy evidence → re-judge → answer; buy() handles the 402
  budget.js         budget counter (total + per-purchase cap)
  payer.js          payment adapter: mock / solana
  cli.js            run the whole question set from the command line
public/             plain HTML + JS page, served statically; scores, budget and ledger live in localStorage
api/index.js        Vercel entry: the same Express app as one serverless function
docs/edge-cases.md  how to find edge cases, the categories, data shapes, how to add a case
```

## How payment works

A paid route returns 402 when the `X-Payment` header is missing; the quote looks like this:

```json
{ "x402Version": 2, "error": "payment_required",
  "accepts": [{ "scheme": "mock", "network": "solana:devnet", "asset": "USDC", "price": "0.0200",
                "payTo": "…", "resource": "/check/simulate", "nonce": "…", "maxTimeoutSeconds": 120 }] }
```

- **mock** (default): the agent base64-encodes `{ nonce, amount, payer }` into `X-Payment`; the server checks that the nonce is unused and the amount covers the price. No chain involved; it runs end to end in a minute.
- **solana**: `PAYMENT_SCHEME=solana`; the agent makes a real SOL transfer on devnet (`AGENT_KEYPAIR`), the signature serves as the proof, and the server verifies the payment landed. The four functions on this path live in `server/live.js` and **have not been run on devnet yet**.
- **Switching to x402**: on the seller side, replace `paywall.charge()` with the `@x402/express` + `@x402/svm` middleware; on the agent side, replace `agent/payer.js` with `wrapFetchWithPayment` from `@x402/fetch`. `buy()` in `agent/loop.js` and the four checks stay untouched.

Prices: simulation $0.02, address $0.01, program $0.01, domain $0.005. The agent's default total budget is $0.25 with a $0.05 per-purchase cap (`.env.example`).

## When the agent spends

`analyze(surface, facts)` returns `confidence` and `missing` (which evidence is still lacking). Below 0.8 confidence it buys in order of information value, highest first: simulation → address → program → domain, re-running the rules after every purchase. Each purchase goes through the budget first; if the budget refuses, the agent stops and reports the reason. A few typical runs:

| Question | Free heuristics | Then |
|---|---|---|
| q01 unlimited Approve | 92% scam | spends nothing |
| q10 honeypot token | 50%, sees nothing | buys simulation (normal) → program check on the MOON mint → permanentDelegate → scam |
| q31 CPI drain | 35%, only knows an unfamiliar program touched a token account | buys simulation: USDC −1000, nothing comes back → scam |
| q02 normal swap | 65% safe | buys simulation / program check for the green lights → 95% safe |

## Coverage

60 cases: 45 have a question, 10 are still waiting for one, 5 are `depends` (a threshold has to be set first). `npm run coverage` prints the breakdown.

## Deploy to Vercel

The server keeps no state (scores, the agent's running budget and its ledger live in the browser; paywall nonces are HMAC-signed), so the whole Express app runs as one serverless function. `vercel.json` rewrites every non-static path to `api/index.js` and serves `public/` from the CDN.

1. Push the repo to GitHub, then at https://vercel.com/new import `linqizhe07/scam-or-safe`. Framework preset: **Other**. No build command, no output directory.
2. Optional environment variables: `PAYMENT_SECRET` (any long random string; signs the mock 402 nonces — set it so all instances agree), `AGENT_BUDGET_USD`, `AGENT_PER_CALL_MAX_USD`.
3. Deploy. The agent pays its own deployment's `/check/*` routes over HTTPS, so keep the production deployment public (Vercel's deployment protection on preview URLs would block those self-calls).

Or from the CLI:

```text
npm i -g vercel
vercel login
vercel --prod
```

## Known limitations

- The transactions in the question bank are normalized JSON, not real serialized transactions. Building real devnet transactions is the next step.
- The facts about addresses / programs / domains are hard-coded in the knowledge base; `LIVE=1` only adds the program-check and simulation devnet paths, and neither has been tested.
- The detector is a rule engine, not a model. Its strength is clear explanations; its weakness is shapes it has never seen.
- Every address is fictional except real program IDs / official mints.
