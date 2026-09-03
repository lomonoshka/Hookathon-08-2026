# Homelander

A Uniswap v4 hook that turns the MEV a pool creates into yield for that pool, instead of losing it to searchers.

- 🎥 **Demo video:** https://youtu.be/Eg1e4NJn6mc
- 📖 **Docs:** https://seoeva.github.io/Homelander-hookathon-docs/
- 🌐 **Live app (Sepolia):** http://204.168.153.69:8094

## The problem

A swap moves a pool's price out of line with the rest of the market. That gap is real value, and today it doesn't stay with the pool — a searcher captures it in the next transaction, and most of what they extract goes to the builder/validator who let them in. The pool created that value and sees none of it.

Raising the swap fee doesn't fix this: a fee high enough to price out the arbitrage also prices out normal trading, and the pool still can't tell which swap is the informed one — it can only charge everyone the same rate.

## How Homelander works

Instead of taxing the arbitrage, the hook runs it itself, inside the same transaction the swap that created it happened in:

1. **`beforeSwap`** — prices the swap against a Chainlink reference. A swap that pushes the pool price away from the oracle pays a directional penalty fee (up to a configurable max); a swap that corrects the pool back toward the oracle pays less. This needed Uniswap v4's per-swap dynamic-fee override — a static-fee pool can't do this at all.
2. **`afterSwap`** — checks whether the swap just opened a real arbitrage gap against a reference pool. If it did, the hook executes the arbitrage itself, in a separate gas-capped call whose result is never checked — a failed or unprofitable attempt just returns, and the original swap goes through exactly as if the hook weren't there. There's nothing left over for an external bot to pick up in the next block.

## Partner integrations

**Chainlink** — the directional fee curve reads price data through Chainlink's standard `AggregatorV3Interface` (`contracts/HomelanderUniV4PluginChainlinkPmm.sol`, `ChainlinkPmmConfig.token0UsdFeed` / `token1UsdFeed`). This means it works against any real Chainlink feed out of the box (e.g. the real Sepolia ETH/USD feed at `0x694AA1769357215DE4FAC081bf1f309aDC325306`). For the live demo specifically, the deploy wizard instead points each pool at its own `MockV3Aggregator` (Chainlink's own official mock contract, from `@chainlink/contracts`) so the fee curve can be shown reacting live to a manual price push, rather than waiting on a real feed's slower update cadence.

No other partner integrations.

## Contracts

- `contracts/HomelanderUniV4PluginChainlinkPmm.sol` — the hook. Directional Chainlink-oracle-deviation fee curve + arbitrage self-capture. This is what both the showcase pool and the deploy wizard actually deploy.
- `contracts/HomelanderUniV4Plugin.sol` — an earlier fee-curve design (EWMA-volatility tiers, no oracle input), kept alongside the current hook with its own test suite.
- `contracts/demo-arbitrage/` — `DemoMevxRouter` / `DemoMevxExecutor` / `DemoProfitDistributor`: a small, hackathon-original arbitrage-execution stack the hook calls into. Written from scratch for this project, not a production system.
- `contracts/mocks/` — `MockV3Aggregator` (Chainlink's own mock) plus small test doubles for the demo stack.

## Frontend

`frontend/` — a self-serve Next.js app:

- **Deploy** — walks anyone through deploying their own Homelander-protected pool on Sepolia: deploy the hook, wire in two Chainlink feeds, initialize the pool, add liquidity. Every step's transaction is real and independently verifiable, and the deploy history is reconstructed live from on-chain data (not local browser state), so it's the same for every visitor, not just whoever ran the wizard.
- **Dashboard** — the live state of the current showcase pool: fee tier, oracle prices, arbitrage-spread check, real captured-MEV history, and a one-click "run the whole demo" button.
- **Mainnet** — real Homelander activity already running on Base mainnet, read directly from chain.

## Running it

```bash
npm install
npx hardhat compile
npx hardhat test        # unit tests
npx hardhat coverage    # coverage report
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

## Base fork test

`test/base-fork/arbitrageDonate.base-fork.ts` exercises the whole capture path against real Base
mainnet state instead of mocks. It deploys the hook at a CREATE2-mined address, creates a native
ETH/USDC pool, seeds it with 100k USDC and the matching amount of ETH, then swaps ETH in to open
a gap against the Uniswap V3 WETH/USDC pool — and checks that the backrun fired and that the
profit is withdrawable by an LP. Every swap in the transaction is logged, so the profit can be
traced leg by leg. It runs against a local anvil fork (Foundry required) and needs no private
keys; set `BASE_FORK_BLOCK_NUMBER` to pin the fork and make repeated runs fast.

```bash
cp .env.example .env    # set ETH_NODE_URI_BASE_MAINNET
yarn test:fork:base
```

The hook only backruns pools the router has routes for, and routes are keyed by a poolId derived
from the hook address — so they have to be uploaded for the exact plugin build under test.
