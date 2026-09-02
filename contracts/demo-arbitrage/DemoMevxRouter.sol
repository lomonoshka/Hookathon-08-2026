// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {Constants} from "../Constants.sol";

/// @notice Hackathon-original arbitrage router. Compares the hook-protected pool's live price
/// against a single owner-registered reference Uniswap v4 pool for the same token pair; if
/// they've diverged past a configurable threshold, hands back a two-leg swap plan.
///
/// This is a fresh, from-scratch implementation written for this submission — it does not
/// reuse Homelander's production multi-DEX pricing engine (which scans 11 different DEX types
/// via a compact route-card format and stays private). The only thing it shares with the real
/// system is the wire format of `initializePoolExternally`'s `data` argument, because that
/// encoding is defined by (and public via) HomelanderUniV4Plugin.sol's own `_afterInitialize`.
contract DemoMevxRouter is Ownable {
	using StateLibrary for IPoolManager;
	using PoolIdLibrary for PoolKey;

	IPoolManager public immutable poolManager;

	mapping(bytes32 => PoolKey) public protectedPool;
	mapping(bytes32 => PoolKey) public referencePool;
	mapping(bytes32 => bool) public hasReferencePool;

	uint256 public minSpreadBps = 20; // 0.20% minimum divergence before we bother arbing
	uint256 public demoTradeAmount = 0.01 ether; // fixed, conservative demo trade size (in currency1 units)
	uint256 public constant BPS_DENOM = 10_000;

	event PoolRegistered(bytes32 indexed poolId, PoolKey key);
	event ReferencePoolSet(bytes32 indexed poolId, PoolKey referenceKey);
	event MinSpreadBpsSet(uint256 oldValue, uint256 newValue);
	event DemoTradeAmountSet(uint256 oldValue, uint256 newValue);

	constructor(IPoolManager poolManager_, address owner_) {
		poolManager = poolManager_;
		_transferOwnership(owner_);
	}

	// ──────────────────── Pool registration (called by the hook) ────────────────────

	function initializePool(bytes32, uint16, bytes memory) external {}

	function initializePoolExternally(bytes32 poolId, uint16 poolType, bytes memory data) external {
		if (poolType != Constants.UNISWAP_V4_POOL_TYPE || data.length < 46) {
			return;
		}

		(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) = _decodeCard(data);
		PoolKey memory key = PoolKey({
			currency0: Currency.wrap(currency0),
			currency1: Currency.wrap(currency1),
			fee: fee,
			tickSpacing: tickSpacing,
			hooks: IHooks(hooks)
		});
		protectedPool[poolId] = key;
		emit PoolRegistered(poolId, key);
	}

	// ──────────────────── Admin ────────────────────

	function setReferencePool(bytes32 poolId, PoolKey calldata refKey) external onlyOwner {
		referencePool[poolId] = refKey;
		hasReferencePool[poolId] = true;
		emit ReferencePoolSet(poolId, refKey);
	}

	function setMinSpreadBps(uint256 _minSpreadBps) external onlyOwner {
		require(_minSpreadBps > 0 && _minSpreadBps < BPS_DENOM, "bad spread");
		emit MinSpreadBpsSet(minSpreadBps, _minSpreadBps);
		minSpreadBps = _minSpreadBps;
	}

	function setDemoTradeAmount(uint256 amount) external onlyOwner {
		require(amount > 0, "bad amount");
		emit DemoTradeAmountSet(demoTradeAmount, amount);
		demoTradeAmount = amount;
	}

	// ──────────────────── IMevxRouter ────────────────────

	function initialArbCheck(bytes32 poolId, bool) external view returns (bool isArbPossible, bytes16 priceChange) {
		(bool possible, uint256 spreadBps, , ) = _evaluate(poolId);
		return (possible, bytes16(uint128(spreadBps)));
	}

	function constructArbitrageRoute(
		bytes32 poolId,
		bool,
		bytes16,
		int256,
		int256
	)
		external
		view
		returns (
			bool isArbPossible,
			address profitToken,
			address[] memory pools,
			uint256 optimalAmountIn,
			bytes memory encodedRoute
		)
	{
		(bool possible, , PoolKey memory cheapKey, PoolKey memory richKey) = _evaluate(poolId);
		if (!possible) {
			return (false, address(0), new address[](0), 0, "");
		}

		pools = new address[](1);
		pools[0] = address(poolManager);
		profitToken = Currency.unwrap(cheapKey.currency1);
		optimalAmountIn = demoTradeAmount;
		// zeroForOne=false on the cheap pool: pay currency1, receive currency0 (it's cheap there).
		// zeroForOne=true on the rich pool: pay currency0, receive currency1 (it's dear there).
		encodedRoute = abi.encode(cheapKey, false, richKey, true);
		isArbPossible = true;
	}

	function getMevProtectionFee(uint16) external pure returns (uint24 pluginFee) {
		return 0;
	}

	// ──────────────────── Internal ────────────────────

	function _evaluate(
		bytes32 poolId
	) internal view returns (bool possible, uint256 spreadBps, PoolKey memory cheapKey, PoolKey memory richKey) {
		if (!hasReferencePool[poolId]) {
			return (false, 0, cheapKey, richKey);
		}

		PoolKey memory keyA = protectedPool[poolId];
		PoolKey memory keyB = referencePool[poolId];
		if (Currency.unwrap(keyA.currency0) == address(0)) {
			return (false, 0, cheapKey, richKey);
		}

		(uint160 sqrtPriceA, , , ) = poolManager.getSlot0(keyA.toId());
		(uint160 sqrtPriceB, , , ) = poolManager.getSlot0(keyB.toId());
		if (sqrtPriceA == 0 || sqrtPriceB == 0) {
			return (false, 0, cheapKey, richKey);
		}

		uint256 diff = sqrtPriceA > sqrtPriceB ? sqrtPriceA - sqrtPriceB : sqrtPriceB - sqrtPriceA;
		spreadBps = (diff * BPS_DENOM) / uint256(sqrtPriceA);
		possible = spreadBps >= minSpreadBps;

		// Higher sqrtPriceX96 means currency0 is more expensive (in terms of currency1) there.
		bool aIsCheap = sqrtPriceA < sqrtPriceB;
		cheapKey = aIsCheap ? keyA : keyB;
		richKey = aIsCheap ? keyB : keyA;
	}

	function _decodeCard(
		bytes memory data
	) private pure returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) {
		assembly {
			let base := add(data, 32)
			currency0 := shr(96, mload(base))
			currency1 := shr(96, mload(add(base, 20)))
			let feeAndTickAndHooks := mload(add(base, 40))
			fee := shr(232, feeAndTickAndHooks)
			tickSpacing := signextend(2, shr(208, feeAndTickAndHooks))
			hooks := shr(48, feeAndTickAndHooks)
		}
	}
}
