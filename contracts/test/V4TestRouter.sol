// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev TEST-ONLY. Minimal unlock driver for adding liquidity, collecting fees and swapping.
/// Funds are pulled from `msg.sender`, who must approve this router for the ERC20 side and
/// send the native side as `msg.value`. Leftovers are returned to the caller.
contract V4TestRouter is IUnlockCallback {
	using SafeERC20 for IERC20;
	using StateLibrary for IPoolManager;

	enum Action {
		ADD_LIQUIDITY,
		COLLECT,
		SWAP
	}

	IPoolManager public immutable poolManager;

	struct CallbackData {
		Action action;
		address sender;
		PoolKey key;
		int24 tickLower;
		int24 tickUpper;
		uint256 amount0;
		uint256 amount1;
		bool zeroForOne;
	}

	constructor(IPoolManager _poolManager) {
		poolManager = _poolManager;
	}

	receive() external payable {}

	/// @notice Mints a position sized to `amount0Desired`/`amount1Desired` over [tickLower, tickUpper].
	function addLiquidity(
		PoolKey calldata key,
		int24 tickLower,
		int24 tickUpper,
		uint256 amount0Desired,
		uint256 amount1Desired
	) external payable returns (BalanceDelta delta) {
		delta = abi.decode(
			poolManager.unlock(
				abi.encode(
					CallbackData(
						Action.ADD_LIQUIDITY,
						msg.sender,
						key,
						tickLower,
						tickUpper,
						amount0Desired,
						amount1Desired,
						false
					)
				)
			),
			(BalanceDelta)
		);
		_refund();
	}

	/// @notice Zero-delta modifyLiquidity: pulls accrued fees of the caller's position out to them.
	function collect(PoolKey calldata key, int24 tickLower, int24 tickUpper) external returns (BalanceDelta delta) {
		delta = abi.decode(
			poolManager.unlock(
				abi.encode(CallbackData(Action.COLLECT, msg.sender, key, tickLower, tickUpper, 0, 0, false))
			),
			(BalanceDelta)
		);
		_refund();
	}

	function swapExactIn(
		PoolKey calldata key,
		bool zeroForOne,
		uint256 amountIn
	) external payable returns (BalanceDelta delta) {
		delta = abi.decode(
			poolManager.unlock(
				abi.encode(CallbackData(Action.SWAP, msg.sender, key, 0, 0, amountIn, 0, zeroForOne))
			),
			(BalanceDelta)
		);
		_refund();
	}

	function unlockCallback(bytes calldata rawData) external returns (bytes memory) {
		require(msg.sender == address(poolManager), "not pool manager");
		CallbackData memory data = abi.decode(rawData, (CallbackData));

		if (data.action == Action.SWAP) {
			return abi.encode(_swap(data));
		}
		return abi.encode(_modifyLiquidity(data));
	}

	function _modifyLiquidity(CallbackData memory data) internal returns (BalanceDelta callerDelta) {
		int256 liquidityDelta = 0;
		if (data.action == Action.ADD_LIQUIDITY) {
			(uint160 sqrtPriceX96, , , ) = poolManager.getSlot0(PoolId.wrap(_toId(data.key)));
			liquidityDelta = int256(
				uint256(
					LiquidityAmounts.getLiquidityForAmounts(
						sqrtPriceX96,
						TickMath.getSqrtPriceAtTick(data.tickLower),
						TickMath.getSqrtPriceAtTick(data.tickUpper),
						data.amount0,
						data.amount1
					)
				)
			);
			require(liquidityDelta > 0, "zero liquidity");
		}

		(callerDelta, ) = poolManager.modifyLiquidity(
			data.key,
			ModifyLiquidityParams({
				tickLower: data.tickLower,
				tickUpper: data.tickUpper,
				liquidityDelta: liquidityDelta,
				salt: bytes32(0)
			}),
			""
		);

		_resolve(data.key.currency0, data.sender, callerDelta.amount0());
		_resolve(data.key.currency1, data.sender, callerDelta.amount1());
	}

	function _swap(CallbackData memory data) internal returns (BalanceDelta delta) {
		delta = poolManager.swap(
			data.key,
			SwapParams({
				zeroForOne: data.zeroForOne,
				amountSpecified: -int256(data.amount0),
				sqrtPriceLimitX96: data.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
			}),
			""
		);

		_resolve(data.key.currency0, data.sender, delta.amount0());
		_resolve(data.key.currency1, data.sender, delta.amount1());
	}

	/// @dev Negative delta is owed to the PoolManager, positive is claimable by us.
	function _resolve(Currency currency, address payer, int128 amount) internal {
		if (amount < 0) {
			uint256 owed = uint256(uint128(-amount));
			if (currency.isAddressZero()) {
				poolManager.settle{value: owed}();
			} else {
				poolManager.sync(currency);
				IERC20(Currency.unwrap(currency)).safeTransferFrom(payer, address(poolManager), owed);
				poolManager.settle();
			}
		} else if (amount > 0) {
			poolManager.take(currency, payer, uint256(uint128(amount)));
		}
	}

	function _refund() internal {
		uint256 balance = address(this).balance;
		if (balance > 0) {
			(bool ok, ) = msg.sender.call{value: balance}("");
			require(ok, "refund failed");
		}
	}

	function _toId(PoolKey memory key) internal pure returns (bytes32 poolId) {
		assembly ("memory-safe") {
			poolId := keccak256(key, 0xa0)
		}
	}
}
