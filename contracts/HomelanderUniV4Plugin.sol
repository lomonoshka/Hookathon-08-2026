// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

import {Constants} from "./Constants.sol";
import {IMevxExecutor} from "./interfaces/IMevxExecutor.sol";
import {IMevxRouter} from "./interfaces/IMevxRouter.sol";
import {IProfitDistributor} from "./interfaces/IProfitDistributor.sol";

contract HomelanderUniV4Plugin is BaseHook, Ownable2Step {
	/// @dev Uniswap v4 dynamic-fee sentinel + default LP fee (fee pips).
	/// Encoding: `dynamicFee = 0x800000 | defaultFeePips`.
	uint24 public immutable dynamicFee;

	bytes32 public configId;
	IProfitDistributor public profitDistributor;
	IMevxExecutor public mevxExecutor;
	IMevxRouter public mevxRouter;

	uint256 public minGasLeft;
	uint256 public callGasBudget;

	uint256 public constant MAX_MIN_GAS_LEFT = 2_500_000;
	uint256 public constant MAX_CALL_GAS_BUDGET = 5_000_000;

	/// @dev Chainlink Data Feed used to gauge realized volatility for dynamic fee tiering.
	/// When unset (address(0)), beforeSwap falls back to the static `defaultFeePips` behavior.
	AggregatorV3Interface public priceFeed;
	int256 public lastObservedPrice;
	uint256 public volatilityScore;

	uint24 public lowVolFeePips;
	uint24 public highVolFeePips;
	uint256 public lowVolThreshold;
	uint256 public highVolThreshold;

	/// @dev EWMA smoothing window (in swaps) for `volatilityScore`, and the basis-point denominator
	/// used to express per-swap price moves.
	uint256 public constant VOLATILITY_SMOOTHING = 10;
	uint256 public constant BPS_DENOM = 10_000;

	event ConfigIdSet(bytes32 oldConfigId, bytes32 newConfigId);
	event ProfitDistributorSet(address oldProfitDistributor, address newProfitDistributor);
	event MevxExecutorSet(address oldMevxExecutor, address newMevxExecutor);
	event MevxRouterSet(address oldMevxRouter, address newMevxRouter);
	event MinGasLeftSet(uint256 oldMinGasLeft, uint256 newMinGasLeft);
	event CallGasBudgetSet(uint256 oldCallGasBudget, uint256 newCallGasBudget);
	event PriceFeedSet(address oldPriceFeed, address newPriceFeed);
	event VolatilityFeeTiersSet(
		uint24 lowVolFeePips,
		uint24 highVolFeePips,
		uint256 lowVolThreshold,
		uint256 highVolThreshold
	);

	constructor(
		IPoolManager _poolManager,
		address owner_,
		address mevxRouter_,
		address mevxExecutor_,
		address profitDistributor_,
		uint24 dynamicFee_
	) BaseHook(_poolManager) {
		require(owner_ != address(0), "owner is zero address");
		require(mevxRouter_ != address(0), "mevxRouter is zero address");
		require(mevxExecutor_ != address(0), "mevxExecutor is zero address");
		require(profitDistributor_ != address(0), "profitDistributor is zero address");

		_transferOwnership(owner_);
		mevxExecutor = IMevxExecutor(mevxExecutor_);
		mevxRouter = IMevxRouter(mevxRouter_);
		profitDistributor = IProfitDistributor(profitDistributor_);

		if (dynamicFee_ & LPFeeLibrary.DYNAMIC_FEE_FLAG != 0) {
			uint24 defaultFeePips = dynamicFee_ & 0x7FFFFF;
			require(defaultFeePips <= LPFeeLibrary.MAX_LP_FEE, "Invalid defaultFeePips");
		} else {
			require(dynamicFee_ == 0, "dynamicFee must be 0 when dynamicFee flag is not set");
		}

		dynamicFee = dynamicFee_;
		callGasBudget = MAX_CALL_GAS_BUDGET;
	}

	function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
		return
			Hooks.Permissions({
				beforeInitialize: false,
				afterInitialize: true,
				beforeAddLiquidity: false,
				afterAddLiquidity: false,
				beforeRemoveLiquidity: false,
				afterRemoveLiquidity: false,
				beforeSwap: true,
				afterSwap: true,
				beforeDonate: false,
				afterDonate: false,
				beforeSwapReturnDelta: false,
				afterSwapReturnDelta: false,
				afterAddLiquidityReturnDelta: false,
				afterRemoveLiquidityReturnDelta: false
			});
	}

	// ──────────────────── Admin ────────────────────

	function setConfigId(bytes32 _configId) external onlyOwner {
		bytes32 oldConfigId = configId;
		configId = _configId;
		emit ConfigIdSet(oldConfigId, _configId);
	}

	function setProfitDistributor(IProfitDistributor _profitDistributor) external onlyOwner {
		require(address(_profitDistributor) != address(0), "profitDistributor is zero address");
		address oldProfitDistributor = address(profitDistributor);
		profitDistributor = _profitDistributor;
		emit ProfitDistributorSet(oldProfitDistributor, address(_profitDistributor));
	}

	function setMevxExecutor(IMevxExecutor _mevxExecutor) external onlyOwner {
		require(address(_mevxExecutor) != address(0), "mevxExecutor is zero address");
		address oldMevxExecutor = address(mevxExecutor);
		mevxExecutor = _mevxExecutor;
		emit MevxExecutorSet(oldMevxExecutor, address(_mevxExecutor));
	}

	function setMevxRouter(IMevxRouter _mevxRouter) external onlyOwner {
		require(address(_mevxRouter) != address(0), "mevxRouter is zero address");
		address oldMevxRouter = address(mevxRouter);
		mevxRouter = _mevxRouter;
		emit MevxRouterSet(oldMevxRouter, address(_mevxRouter));
	}

	function setMinGasLeft(uint256 minGasLeft_) external onlyOwner {
		require(minGasLeft_ <= MAX_MIN_GAS_LEFT, "minGasLeft too high");
		uint256 oldMinGasLeft = minGasLeft;
		minGasLeft = minGasLeft_;
		emit MinGasLeftSet(oldMinGasLeft, minGasLeft_);
	}

	function setCallGasBudget(uint256 callGasBudget_) external onlyOwner {
		require(callGasBudget_ <= MAX_CALL_GAS_BUDGET, "callGasBudget too high");
		uint256 oldCallGasBudget = callGasBudget;
		callGasBudget = callGasBudget_;
		emit CallGasBudgetSet(oldCallGasBudget, callGasBudget_);
	}

	function renounceOwnership() public view override onlyOwner {
		revert("Ownership cannot be renounced");
	}

	function setPriceFeed(AggregatorV3Interface _priceFeed) external onlyOwner {
		address oldPriceFeed = address(priceFeed);
		priceFeed = _priceFeed;
		lastObservedPrice = 0;
		volatilityScore = 0;
		emit PriceFeedSet(oldPriceFeed, address(_priceFeed));
	}

	function setVolatilityFeeTiers(
		uint24 _lowVolFeePips,
		uint24 _highVolFeePips,
		uint256 _lowVolThreshold,
		uint256 _highVolThreshold
	) external onlyOwner {
		require(_lowVolFeePips <= LPFeeLibrary.MAX_LP_FEE, "lowVolFeePips too high");
		require(_highVolFeePips <= LPFeeLibrary.MAX_LP_FEE, "highVolFeePips too high");
		require(_lowVolThreshold < _highVolThreshold, "thresholds out of order");

		lowVolFeePips = _lowVolFeePips;
		highVolFeePips = _highVolFeePips;
		lowVolThreshold = _lowVolThreshold;
		highVolThreshold = _highVolThreshold;

		emit VolatilityFeeTiersSet(_lowVolFeePips, _highVolFeePips, _lowVolThreshold, _highVolThreshold);
	}

	// ──────────────────── Hooks ────────────────────

	function _beforeSwap(
		address sender,
		PoolKey calldata,
		SwapParams calldata,
		bytes calldata
	) internal view override returns (bytes4, BeforeSwapDelta, uint24) {
		// Feature disabled => no fee override
		if (dynamicFee & LPFeeLibrary.DYNAMIC_FEE_FLAG == 0) {
			return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
		}

		uint24 defaultFeePips = dynamicFee & 0x7FFFFF;
		uint24 feeToUse = _feeForSender(sender, defaultFeePips);

		return (
			BaseHook.beforeSwap.selector,
			BeforeSwapDeltaLibrary.ZERO_DELTA,
			LPFeeLibrary.OVERRIDE_FEE_FLAG | feeToUse
		);
	}

	/// @dev The internal executor always trades at 0 fee. Everyone else pays `defaultFeePips`,
	/// unless a Chainlink price feed is configured, in which case the fee is tiered off of
	/// `volatilityScore` (see `_updateVolatility`).
	function _feeForSender(address sender, uint24 defaultFeePips) internal view returns (uint24) {
		if (sender == address(mevxExecutor)) {
			return 0;
		}

		if (address(priceFeed) == address(0)) {
			return defaultFeePips;
		}

		if (volatilityScore >= highVolThreshold) {
			return highVolFeePips;
		}

		if (volatilityScore <= lowVolThreshold) {
			return lowVolFeePips;
		}

		return defaultFeePips;
	}

	/// @dev Pulls the latest Chainlink price and folds the observed move (in bps) into an EWMA
	/// stored in `volatilityScore`. Never reverts the swap: a stale/misbehaving feed just means
	/// the fee tier doesn't update this swap.
	function _updateVolatility() internal {
		if (address(priceFeed) == address(0)) {
			return;
		}

		try priceFeed.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
			if (answer <= 0 || updatedAt == 0) {
				return;
			}

			if (lastObservedPrice != 0) {
				uint256 diff = answer > lastObservedPrice
					? uint256(answer - lastObservedPrice)
					: uint256(lastObservedPrice - answer);
				uint256 moveBps = (diff * BPS_DENOM) / uint256(lastObservedPrice);
				volatilityScore = (volatilityScore * (VOLATILITY_SMOOTHING - 1) + moveBps) / VOLATILITY_SMOOTHING;
			}

			lastObservedPrice = answer;
		} catch {}
	}

	function _afterInitialize(address, PoolKey calldata key, uint160, int24) internal override returns (bytes4) {
		bytes32 poolId = PoolId.unwrap(key.toId());
		bytes memory data = abi.encodePacked(
			Currency.unwrap(key.currency0),
			Currency.unwrap(key.currency1),
			key.fee,
			key.tickSpacing,
			address(key.hooks)
		);
		bytes memory initData = abi.encodeCall(
			IMevxRouter.initializePoolExternally,
			(poolId, Constants.UNISWAP_V4_POOL_TYPE, data)
		);
		address(mevxRouter).call{gas: callGasBudget}(initData);

		return BaseHook.afterInitialize.selector;
	}

	function _afterSwap(
		address sender,
		PoolKey calldata key,
		SwapParams calldata params,
		BalanceDelta delta,
		bytes calldata
	) internal override returns (bytes4, int128) {
		if (sender != address(mevxExecutor)) {
			require(gasleft() >= minGasLeft, "Insufficient gas for afterSwap hook");
		}

		_updateVolatility();

		bytes32 poolId = PoolId.unwrap(key.toId());

		bytes memory branchData = abi.encodeCall(
			this.runArbitrage,
			(poolId, params.zeroForOne, -delta.amount0(), -delta.amount1(), sender)
		);

		address(this).call{gas: callGasBudget}(branchData);

		return (BaseHook.afterSwap.selector, 0);
	}

	function runArbitrage(
		bytes32 poolId,
		bool zeroForOne,
		int128 negAmount0,
		int128 negAmount1,
		address sender
	) external {
		require(msg.sender == address(this), "self only");

		bytes memory initialArbCheckCallData = abi.encodeWithSelector(
			IMevxRouter.initialArbCheck.selector,
			poolId,
			!zeroForOne
		);

		(bool successInitialArbCheck, bytes memory returnDataInitialArbCheck) = address(mevxRouter).call(
			initialArbCheckCallData
		);

		if (sender == address(mevxExecutor)) {
			return;
		}

		if (!successInitialArbCheck || returnDataInitialArbCheck.length != 64) {
			return;
		}

		(bool isArbPossible, bytes16 arbData) = abi.decode(returnDataInitialArbCheck, (bool, bytes16));

		if (!isArbPossible) {
			return;
		}

		bytes memory callData = abi.encodeWithSelector(
			IMevxRouter.constructArbitrageRoute.selector,
			poolId,
			zeroForOne,
			arbData,
			negAmount0,
			negAmount1
		);

		address profitToken;
		address[] memory pools;
		uint256 amountIn;
		bytes memory encodedRoute;

		(bool success, bytes memory returnData) = address(mevxRouter).call(callData);
		if (success && returnData.length >= 224) {
			(isArbPossible, profitToken, pools, amountIn, encodedRoute) = abi.decode(
				returnData,
				(bool, address, address[], uint256, bytes)
			);
		}

		IProfitDistributor profitDistributor_ = profitDistributor;

		if (isArbPossible) {
			try mevxExecutor.executeRoute(encodedRoute, pools, amountIn, profitToken, address(profitDistributor_)) {
				try profitDistributor_.distributeProfit(configId, profitToken, sender) {} catch {}
			} catch {}
		}
	}
}
