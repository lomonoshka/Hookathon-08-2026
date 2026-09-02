// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {CurrencySettler} from "@uniswap/v4-core/test/utils/CurrencySettler.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Hackathon-original executor. Pre-funded (no flashloan capital-efficiency layer —
/// we hold real Sepolia capital directly), it runs the two-leg swap plan handed to it by
/// DemoMevxRouter, then forwards any realized profit to the profit distributor. Written from
/// scratch for this submission.
/// @dev Calls `IPoolManager.swap` directly rather than through the official `PoolSwapTest` test
/// utility. `executeRoute` always runs *inside* a hook's `_afterSwap` callback — i.e. inside an
/// already-unlocked `PoolManager` — and `PoolSwapTest.swap()` unconditionally calls
/// `manager.unlock(...)` itself, which reverts with `AlreadyUnlocked` when the manager is already
/// unlocked. Settling directly via `CurrencySettler` (the same helper `PoolSwapTest` itself uses
/// internally) works from inside an existing unlock context, since no second `unlock()` call is
/// needed — we're already inside one.
contract DemoMevxExecutor is Ownable {
	using CurrencySettler for Currency;

	IPoolManager public immutable poolManager;
	/// @dev A set, not a single address — every hook that's been registered (showcase pool, or any
	/// visitor's own wizard-deployed pool via the deploy flow's "enable arbitrage demo" step) can
	/// trigger a real capture, not just whichever one was authorized most recently.
	mapping(address => bool) public authorizedCallers;

	uint160 private constant MIN_SQRT_PRICE = 4295128739;
	uint160 private constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

	event AuthorizedCallerSet(address caller, bool authorized);
	event ArbitrageExecuted(address indexed profitToken, address indexed profitRecipient, uint256 profit);

	modifier onlyAuthorized() {
		require(msg.sender == owner() || authorizedCallers[msg.sender], "not authorized");
		_;
	}

	constructor(IPoolManager poolManager_, address owner_) {
		poolManager = poolManager_;
		_transferOwnership(owner_);
	}

	function setAuthorizedCaller(address caller, bool authorized) external onlyOwner {
		authorizedCallers[caller] = authorized;
		emit AuthorizedCallerSet(caller, authorized);
	}

	/// @dev Demo infra only holds a small, shared Sepolia token balance — lets the owner recover it
	/// (e.g. before redeploying a newer executor) instead of stranding funds permanently, which is
	/// exactly what happened to this contract's predecessor.
	function withdraw(address token, uint256 amount, address to) external onlyOwner {
		IERC20(token).transfer(to, amount);
	}

	function executeRoute(
		bytes calldata encodedRoute,
		address[] memory,
		uint256 amountIn,
		address profitToken,
		address profitRecipient
	) external onlyAuthorized {
		(PoolKey memory cheapKey, bool cheapZeroForOne, PoolKey memory richKey, bool richZeroForOne) = abi.decode(
			encodedRoute,
			(PoolKey, bool, PoolKey, bool)
		);

		uint256 profitBefore = IERC20(profitToken).balanceOf(address(this));

		BalanceDelta delta1 = _swap(cheapKey, cheapZeroForOne, int256(amountIn));

		uint256 midAmount = cheapZeroForOne ? uint256(uint128(delta1.amount1())) : uint256(uint128(delta1.amount0()));
		if (midAmount == 0) {
			return;
		}

		_swap(richKey, richZeroForOne, int256(midAmount));

		uint256 profitAfter = IERC20(profitToken).balanceOf(address(this));
		if (profitAfter > profitBefore) {
			uint256 profit = profitAfter - profitBefore;
			IERC20(profitToken).transfer(profitRecipient, profit);
			emit ArbitrageExecuted(profitToken, profitRecipient, profit);
		}
	}

	/// @dev Exact-input swap (matches the fixed `-int256(amountIn)` this executor always used),
	/// settling whichever side we owe from this contract's own held balance and taking whichever
	/// side the pool owes us as a plain ERC20 transfer (no ERC-6909 claims).
	function _swap(PoolKey memory key, bool zeroForOne, int256 amountIn) internal returns (BalanceDelta delta) {
		delta = poolManager.swap(
			key,
			SwapParams({
				zeroForOne: zeroForOne,
				amountSpecified: -amountIn,
				sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1
			}),
			""
		);

		if (delta.amount0() < 0) key.currency0.settle(poolManager, address(this), uint256(uint128(-delta.amount0())), false);
		if (delta.amount1() < 0) key.currency1.settle(poolManager, address(this), uint256(uint128(-delta.amount1())), false);
		if (delta.amount0() > 0) key.currency0.take(poolManager, address(this), uint256(uint128(delta.amount0())), false);
		if (delta.amount1() > 0) key.currency1.take(poolManager, address(this), uint256(uint128(delta.amount1())), false);
	}

	/// @dev The hook only ever calls the 5-arg overload above; this exists solely to satisfy
	/// IMevxExecutor's interface.
	function executeRoute(bytes calldata, address[] memory, uint256, address) external pure {
		revert("unused overload");
	}
}
