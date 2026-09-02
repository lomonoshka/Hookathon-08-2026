# Base mainnet real Homelander pool — raw data cache

Pulled 2026-09-01 via direct JSON-RPC against the public Base mainnet endpoint
`https://mainnet.base.org` (no API key). No subgraph or Blockscout dependency —
Blockscout's `/api/v2/addresses/{addr}` was returning `500` for the hook address
at pull time, and the Base Uniswap V4 subgraph has `hasIndexingErrors: true`
(both confirmed independently this session), so this data was reconstructed
straight from chain via `eth_getLogs`/`eth_getTransactionReceipt`/`eth_call`.

Real pool identified: **EURC/USDC on Base (chainId 8453)**, using a Homelander
hook plugin minted by the permissionless `HomelanderPluginV4Factory`
(`0x54854a10C3d356F4b32429beEd2e95Ce270D3b35`), created by an external wallet —
**not** the team's known deploy wallet — on ~2026-06-05.

- `poolId`: `0x862c1adf56ba8fa642e57d2565733c0c005827946e300875d9decb836b3fafbc`
- `PoolManager`: `0x498581fF718922c3f8e6A244956aF099B2652b2b` (canonical Uniswap V4 on Base)
- `hooks` (verified from the `Initialize` event's non-indexed data, not from any
  doc note): `0xcc05a232b1ff40427a4bd50a19e2255ae0fa10c0` — a per-pool
  beacon-proxy plugin instance. Its beacon (`0x270dB5c718ec71Fed220cd221F5d48b1Dc531249`)
  resolves (`implementation()`, `eth_call`) to shared hook logic at
  `0x9d1c6a1eb5c9a5f61d23a12cb8828fe192077126`. This is a **different** contract
  from the legacy standalone hook `0xDFe0F6D6CdDA8f8EA47D6C5bDDbdea51425290C0` —
  this pool does not use that one.
- `currency0`: EURC `0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42` (6 decimals)
- `currency1`: USDC `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` (6 decimals, Base canonical)
- fee: dynamic-fee flag set (`0x800000`), tickSpacing 60
- Creator wallet: `0xfee77a870474b320f8ca3b8711dd76d87c045f24` (independent EOA
  with a broad pre-existing DeFi history — 1inch, Permit2, WETH/USDC transfers —
  not documented anywhere in either project's access registry)

## Files

- `swap_events_raw_2026-09-01.jsonl` — raw `eth_getLogs` responses (topic0=Swap,
  topic1=poolId) for the pool above, scanned in 10k-block chunks from the pool's
  creation block (47100738) to chain head (50733059) at pull time. **2,989 Swap
  events found**, spanning blocks 47102457–48137778 (~2026-06-09 to 2026-07-03;
  no swap activity found after that up to chain head at pull time). Each JSON-RPC
  response is one line; parse by concatenating all `result` arrays.
- `factory_txlist_2026-09-01.json` — Blockscout classic `txlist` API dump for
  the factory address `0x54854a10C3d356F4b32429beEd2e95Ce270D3b35` (this classic
  endpoint worked fine even while the v2 `/addresses/{addr}` endpoint 500'd).
  Used to discover `createPlugin` calls beyond the one documented team test.
- `creator_txlist_2026-09-01.json` — Blockscout classic `txlist` dump for the
  creator wallet, used to trace the `createPlugin` → `PoolManager.initialize`
  sequence and confirm this wallet's broader independent DeFi activity.

## Regenerating / refreshing

See `frontend/scripts/fetchMainnetPoolStats.ts`, which re-derives the
aggregated JSON the dashboard actually reads
(`frontend/src/data/mainnetPoolStats.json`) from a fresh chain scan using the
constants above. Re-run it before the demo if the swap history needs updating.
