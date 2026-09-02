import { ethers } from 'ethers';

// Matches Hooks.ALL_HOOK_MASK — the lower 14 bits of the hook address encode permissions.
export const HOOK_FLAG_MASK = 0x3fffn;

// Hook permission flags mirrored from @uniswap/v4-core/src/libraries/Hooks.sol.
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

/**
 * Mine a CREATE2 salt such that `deployer`'s resulting contract address has its lower 14
 * bits equal to `flags`. Pure off-chain arithmetic (mirrors the on-chain HookMiner pattern
 * from @uniswap/v4-periphery). `initCode` is creation bytecode + abi-encoded constructor args.
 */
export function mineHookSalt(
	deployer: string,
	flags: bigint,
	initCode: string
): { salt: string; hookAddress: string } {
	const maskedFlags = flags & HOOK_FLAG_MASK;
	const initCodeHash = ethers.keccak256(initCode);

	for (let i = 0; i < MAX_LOOP; i++) {
		const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
		const hookAddress = ethers.getCreate2Address(deployer, salt, initCodeHash);
		if ((BigInt(hookAddress) & HOOK_FLAG_MASK) === maskedFlags) {
			return { salt, hookAddress };
		}
	}

	throw new Error(`mineHookSalt: no salt found within ${MAX_LOOP} iterations`);
}
