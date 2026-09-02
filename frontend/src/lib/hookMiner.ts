import { getCreateAddress, keccak256, pad, toHex, type Address, type Hex } from "viem";

// Matches Hooks.ALL_HOOK_MASK — the lower 14 bits of the hook address encode permissions.
const HOOK_FLAG_MASK = 0x3fffn;

export const HookFlags = {
	BEFORE_INITIALIZE: 1n << 13n,
	AFTER_INITIALIZE: 1n << 12n,
	BEFORE_ADD_LIQUIDITY: 1n << 11n,
	AFTER_ADD_LIQUIDITY: 1n << 10n,
	BEFORE_REMOVE_LIQUIDITY: 1n << 9n,
	AFTER_REMOVE_LIQUIDITY: 1n << 8n,
	BEFORE_SWAP: 1n << 7n,
	AFTER_SWAP: 1n << 6n,
	BEFORE_DONATE: 1n << 5n,
	AFTER_DONATE: 1n << 4n,
} as const;

const MAX_LOOP = 200_000;

function getCreate2Address(deployer: Address, salt: Hex, initCodeHash: Hex): Address {
	const addr = keccak256(
		("0xff" + deployer.slice(2) + salt.slice(2) + initCodeHash.slice(2)) as Hex
	);
	return `0x${addr.slice(-40)}` as Address;
}

/**
 * Mine a CREATE2 salt such that `deployer`'s resulting contract address has its lower 14 bits
 * equal to `flags`. `initCode` is creation bytecode + abi-encoded constructor args (as hex).
 *
 * Starts the search at `startFrom` (random by default, not 0) — two calls with byte-identical
 * `initCode` (same owner + same token pair + same everything else) would otherwise always mine
 * the exact same salt and land on the exact same address, so a second deploy attempt with
 * unchanged inputs (e.g. re-testing with the wallet that already owns an earlier pool) would
 * always collide with whatever was deployed there before and revert.
 */
export function mineHookSalt(
	deployer: Address,
	flags: bigint,
	initCode: Hex,
	startFrom: bigint = BigInt(Math.floor(Math.random() * 1_000_000))
): { salt: Hex; hookAddress: Address } {
	const maskedFlags = flags & HOOK_FLAG_MASK;
	const initCodeHash = keccak256(initCode);

	for (let offset = 0; offset < MAX_LOOP; offset++) {
		const i = startFrom + BigInt(offset);
		const salt = pad(toHex(i), { size: 32 });
		const hookAddress = getCreate2Address(deployer, salt, initCodeHash);
		if ((BigInt(hookAddress) & HOOK_FLAG_MASK) === maskedFlags) {
			return { salt, hookAddress };
		}
	}

	throw new Error(`mineHookSalt: no salt found within ${MAX_LOOP} iterations`);
}

// Re-exported for callers that also want to sanity-check a plain CREATE (nonce-based) address.
export { getCreateAddress };
