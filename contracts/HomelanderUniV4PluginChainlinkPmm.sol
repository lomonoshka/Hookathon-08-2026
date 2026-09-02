// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

import {Constants} from "./Constants.sol";
import {IMevxExecutor} from "./interfaces/IMevxExecutor.sol";
import {IMevxRouter} from "./interfaces/IMevxRouter.sol";
import {IProfitDistributor} from "./interfaces/IProfitDistributor.sol";

/// @title Homelander Uniswap V4 plugin — Chainlink oracle-deviation dynamic fee
/// @notice Alternative to `HomelanderUniV4Plugin`'s EWMA-volatility fee tiers. Where that version
/// charges more when the *pool* has recently been moving a lot (direction-agnostic), this version
/// charges more only when a swap pushes the pool price *away* from a Chainlink oracle reference, and
/// gives a discount when it corrects the pool back toward the oracle — a directional
/// penalty/discount PMM (proactive market-maker) fee curve, priced off Chainlink
/// `AggregatorV3Interface` feeds.
/// @dev Chainlink is push-based, so every read is a free call, unlike a pull-based oracle with a
/// per-read cost — there is no oracle-read spend budget or per-block cache reuse here: every swap
/// reads both feeds fresh. `_beforeSwap` is deliberately *not* `view` — Uniswap v4's
/// `IHooks.beforeSwap` doesn't require it — so the EMA reference-price observation is promoted and
/// re-staged synchronously inside `_beforeSwap`, in the same call that prices the swap. That removes
/// the *extra* staleness a `view`-constrained beforeSwap would force (deferring the write to a later
/// `afterSwap`, on a different hook callback than the one pricing the swap) — it does NOT remove the
/// reference EMA's own, intentional minimum one-block gap: `_promotePendingObservation` only promotes
/// an observation staged in a strictly earlier block (`pendingBlock >= block.number`
/// short-circuits), so an attacker can't stage and promote within one atomic transaction. "No lag"
/// describes the architecture (single call site, not split across callbacks), not a claim that the
/// reference is always current to the block.
contract HomelanderUniV4PluginChainlinkPmm is BaseHook, Ownable2Step {
	using StateLibrary for IPoolManager;

	/// @dev Uniswap v4 dynamic-fee sentinel + default LP fee (fee pips), used as the fallback when
	/// the PMM engine is disabled. Encoding: `dynamicFee = 0x800000 | defaultFeePips`.
	uint24 public immutable dynamicFee;

	bytes32 public configId;
	IProfitDistributor public profitDistributor;
	IMevxExecutor public mevxExecutor;
	IMevxRouter public mevxRouter;

	uint256 public minGasLeft;
	uint256 public callGasBudget;

	uint256 public constant MAX_MIN_GAS_LEFT = 2_500_000;
	uint256 public constant MAX_CALL_GAS_BUDGET = 5_000_000;

	/// @dev Token decimals, cached once at pool init so the per-swap price math never has to make
	/// an extra external call.
	uint8 public token0Decimals;
	uint8 public token1Decimals;

	struct ChainlinkPmmConfig {
		AggregatorV3Interface token0UsdFeed;
		AggregatorV3Interface token1UsdFeed;
		uint8 token0FeedDecimals;
		uint8 token1FeedDecimals;
		uint24 baseFee;
		uint24 maxFee;
		uint24 feePerDeviationBps;
		uint16 neutralThresholdBps;
		uint32 maxOracleAge;
		uint32 observationWindow;
		uint32 minObservationAge;
		uint16 maxSpotToReferenceDeviationBps;
		uint16 maxLimitToSpotDeviationBps;
		bool trackedTokenIsToken0;
		bool enabled;
	}

	ChainlinkPmmConfig public pmmConfig;

	/// @dev Slow EMA of the pool's own price, used only as an anti-manipulation guard (see
	/// `_isPoolReferenceSafe`): if spot has drifted too far from this reference too recently, the
	/// discount branch is refused even if the swap looks oracle-correcting. Promoted from
	/// `pendingPoolPriceWei` once per block, in `_beforeSwap` (see `_computePmmFee`).
	uint256 public referencePoolPriceWei;
	uint64 public observationStartedAt;
	uint64 public referenceTimestamp;
	uint32 public observationCount;

	uint256 public pendingPoolPriceWei;
	uint64 public pendingObservationBlock;
	uint64 public pendingObservationTimestamp;

	uint256 public constant BPS_DENOM = 10_000;
	uint24 public constant MIN_OVERRIDE_FEE = 1;
	/// @dev `_promotePendingObservation` weights a new observation by `elapsed * BPS_DENOM / observationWindow`.
	/// Above this bound a one-second gap rounds to zero weight and the reference silently freezes.
	uint32 public constant MAX_OBSERVATION_WINDOW = uint32(BPS_DENOM);
	/// @dev With a single observation the reference *is* that one pool print, which the first
	/// post-enable swapper chooses. Require at least one EMA update on top of it before the guard
	/// trusts it.
	uint32 public constant MIN_MATURE_OBSERVATIONS = 2;

	uint256 private constant WEI = 1e18;
	uint256 private constant Q64 = 1 << 64;
	uint256 private constant Q128 = 1 << 128;
	uint256 private constant Q192 = 1 << 192;

	event ConfigIdSet(bytes32 oldConfigId, bytes32 newConfigId);
	event ProfitDistributorSet(address oldProfitDistributor, address newProfitDistributor);
	event MevxExecutorSet(address oldMevxExecutor, address newMevxExecutor);
	event MevxRouterSet(address oldMevxRouter, address newMevxRouter);
	event MinGasLeftSet(uint256 oldMinGasLeft, uint256 newMinGasLeft);
	event CallGasBudgetSet(uint256 oldCallGasBudget, uint256 newCallGasBudget);
	event PmmConfigSet(ChainlinkPmmConfig config);
	event PmmEnabledSet(bool enabled);

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

	/// @dev Feed decimals are fetched here (once) rather than on every swap, so a misbehaving feed
	/// can never make `_beforeSwap` revert by reverting on `decimals()`. Resets the EMA reference —
	/// same rationale as `HomelanderUniV4Plugin.setPriceFeed` resetting `volatilityScore`: a stale
	/// reference computed under the old config shouldn't leak into the new one.
	function setPmmConfig(ChainlinkPmmConfig calldata newConfig) external onlyOwner {
		ChainlinkPmmConfig memory cfg = newConfig;
		if (address(cfg.token0UsdFeed) != address(0)) {
			cfg.token0FeedDecimals = cfg.token0UsdFeed.decimals();
		}
		if (address(cfg.token1UsdFeed) != address(0)) {
			cfg.token1FeedDecimals = cfg.token1UsdFeed.decimals();
		}
		_validatePmmConfig(cfg);

		pmmConfig = cfg;
		_clearPmmObservations();
		emit PmmConfigSet(cfg);
	}

	function setPmmEnabled(bool enabled_) external onlyOwner {
		require(!enabled_ || address(pmmConfig.token0UsdFeed) != address(0), "pmm config not set");
		pmmConfig.enabled = enabled_;
		_clearPmmObservations();
		emit PmmEnabledSet(enabled_);
	}

	function _validatePmmConfig(ChainlinkPmmConfig memory cfg) internal pure {
		require(cfg.baseFee >= MIN_OVERRIDE_FEE, "baseFee too low");
		require(cfg.baseFee <= cfg.maxFee, "baseFee above maxFee");
		require(cfg.maxFee < LPFeeLibrary.MAX_LP_FEE, "maxFee too high");
		require(cfg.token0FeedDecimals <= 18 && cfg.token1FeedDecimals <= 18, "feed decimals too high");
		require(cfg.maxOracleAge > 0, "maxOracleAge is zero");
		require(cfg.observationWindow > 0 && cfg.observationWindow <= MAX_OBSERVATION_WINDOW, "observationWindow out of range");
		require(cfg.minObservationAge > 0 && cfg.minObservationAge < cfg.observationWindow, "minObservationAge out of range");
		require(
			cfg.maxSpotToReferenceDeviationBps > 0 && cfg.maxSpotToReferenceDeviationBps <= BPS_DENOM,
			"maxSpotToReferenceDeviationBps out of range"
		);
		require(
			cfg.maxLimitToSpotDeviationBps > 0 && cfg.maxLimitToSpotDeviationBps <= BPS_DENOM,
			"maxLimitToSpotDeviationBps out of range"
		);
		require(cfg.feePerDeviationBps > 0, "feePerDeviationBps is zero");

		// Band ordering: neutral < reference guard < discount saturation. Past `baseFee /
		// feePerDeviationBps` the discount is already pinned at MIN_OVERRIDE_FEE, so a guard band at
		// or beyond that point lets a swap walk to the maximum discount without ever tripping the
		// reference-safety guard.
		uint256 saturationBps = uint256(cfg.baseFee) / cfg.feePerDeviationBps;
		require(cfg.neutralThresholdBps < cfg.maxSpotToReferenceDeviationBps, "neutralThresholdBps too high");
		require(cfg.maxSpotToReferenceDeviationBps < saturationBps, "maxSpotToReferenceDeviationBps too high");

		if (cfg.enabled) {
			require(address(cfg.token0UsdFeed) != address(0), "token0UsdFeed is zero address");
			require(address(cfg.token1UsdFeed) != address(0), "token1UsdFeed is zero address");
		}
	}

	// ──────────────────── Hooks ────────────────────

	function _beforeSwap(
		address sender,
		PoolKey calldata key,
		SwapParams calldata params,
		bytes calldata
	) internal override returns (bytes4, BeforeSwapDelta, uint24) {
		// Feature disabled => no fee override
		if (dynamicFee & LPFeeLibrary.DYNAMIC_FEE_FLAG == 0) {
			return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
		}

		uint24 feeToUse = _feeForSender(sender, key, params);

		return (
			BaseHook.beforeSwap.selector,
			BeforeSwapDeltaLibrary.ZERO_DELTA,
			LPFeeLibrary.OVERRIDE_FEE_FLAG | feeToUse
		);
	}

	/// @dev The internal executor always trades at 0 fee, same as `HomelanderUniV4Plugin`. Its swaps
	/// return before `_computePmmFee` is ever called, so they also never promote or restage the EMA
	/// reference — worth knowing if the executor accounts for a large share of volume, since the
	/// reference then only advances on everyone else's swaps. Everyone else pays `defaultFeePips`
	/// while the PMM engine is disabled, or the oracle-deviation curve once it's enabled.
	function _feeForSender(address sender, PoolKey calldata key, SwapParams calldata params) internal returns (uint24) {
		if (sender == address(mevxExecutor)) {
			return 0;
		}

		ChainlinkPmmConfig memory cfg = pmmConfig;
		if (!cfg.enabled) {
			return dynamicFee & 0x7FFFFF;
		}

		return _computePmmFee(cfg, key, params);
	}

	/// @dev Entry point for the PMM engine, called once per swap from `_beforeSwap`. Promotes whatever
	/// observation is pending from a strictly earlier block into the EMA reference (a no-op if the
	/// last staged observation is from this same block — see `_promotePendingObservation`), prices
	/// this swap off the now-current reference (`_feeForSwap`), then stages this swap's own spot price
	/// for a later swap to promote — all synchronously, in the same call. This removes the *extra* lag
	/// a `view`-constrained `beforeSwap` would force (promote/stage deferred to a separate `afterSwap`
	/// call); it does not, and is not meant to, remove the reference EMA's own built-in minimum
	/// one-block gap between staging and promotion.
	function _computePmmFee(ChainlinkPmmConfig memory cfg, PoolKey calldata key, SwapParams calldata params) internal returns (uint24) {
		_promotePendingObservation(cfg.observationWindow);

		(uint160 sqrtPriceX96, , , ) = poolManager.getSlot0(key.toId());
		(uint24 fee, uint256 poolPrice) = _feeForSwap(cfg, sqrtPriceX96, params);

		if (poolPrice != 0) _stagePendingObservation(poolPrice);
		return fee;
	}

	/// @dev Prices the swap against a live Chainlink USD ratio, applies the directional
	/// penalty/discount curve, takes the worse (higher) of the spot fee and the fee projected at
	/// the swap's clamped limit price, then clamps to at least `baseFee` if the pool has drifted
	/// too far from its own recent-price reference. Every degraded oracle path returns `baseFee` —
	/// fail-open: a bad read degrades to a plain fee-only pool, it never blocks the swap. Halting
	/// swaps belongs to a separate guardian path, not the fee engine. Also returns `poolPrice` (0 if
	/// unusable) so the caller can stage it for the next observation without recomputing it.
	function _feeForSwap(
		ChainlinkPmmConfig memory cfg,
		uint160 sqrtPriceX96,
		SwapParams calldata params
	) internal view returns (uint24 fee, uint256 poolPrice) {
		if (sqrtPriceX96 == 0) return (cfg.baseFee, 0);

		poolPrice = _priceToken1PerToken0Wei(sqrtPriceX96, token0Decimals, token1Decimals);
		if (poolPrice == 0) return (cfg.baseFee, 0);

		(bool hasPrices, uint256 token0Usd, uint256 token1Usd) = _tryGetChainlinkPrices(cfg);
		if (!hasPrices) return (cfg.baseFee, poolPrice);

		(bool representable, uint256 oracleTrackedUsd, uint256 poolTrackedUsd) = _trackedTokenUsdPrices(
			cfg,
			poolPrice,
			token0Usd,
			token1Usd
		);
		if (!representable || oracleTrackedUsd == 0 || poolTrackedUsd == 0) return (cfg.baseFee, poolPrice);

		bool trackedTokenBought = cfg.trackedTokenIsToken0 ? !params.zeroForOne : params.zeroForOne;
		uint24 spotFee = _directionalFee(cfg, oracleTrackedUsd, poolTrackedUsd, trackedTokenBought);
		uint24 limitFee = _projectedLimitFee(cfg, sqrtPriceX96, params, trackedTokenBought, oracleTrackedUsd, token0Usd, token1Usd);
		uint24 conservativeFee = limitFee > spotFee ? limitFee : spotFee;

		fee = !_isPoolReferenceSafe(cfg, poolPrice)
			? (conservativeFee > cfg.baseFee ? conservativeFee : cfg.baseFee)
			: conservativeFee;
	}

	function _tryGetChainlinkPrices(
		ChainlinkPmmConfig memory cfg
	) internal view returns (bool hasPrices, uint256 token0UsdWei, uint256 token1UsdWei) {
		(bool ok0, uint256 p0) = _tryGetUsdPriceWei(cfg.token0UsdFeed, cfg.token0FeedDecimals, cfg.maxOracleAge);
		if (!ok0) return (false, 0, 0);

		(bool ok1, uint256 p1) = _tryGetUsdPriceWei(cfg.token1UsdFeed, cfg.token1FeedDecimals, cfg.maxOracleAge);
		if (!ok1) return (false, 0, 0);

		return (true, p0, p1);
	}

	/// @dev Never reverts: a misbehaving feed (revert, non-positive answer, stale/future timestamp)
	/// just reports "no price", which `_computePmmFee` treats as a reason to fall back to `baseFee`.
	function _tryGetUsdPriceWei(
		AggregatorV3Interface feed,
		uint8 feedDecimals,
		uint32 maxOracleAge
	) internal view returns (bool ok, uint256 priceWei) {
		try feed.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
			if (answer <= 0) return (false, 0);
			if (updatedAt == 0 || updatedAt > block.timestamp) return (false, 0);
			if (block.timestamp - updatedAt > maxOracleAge) return (false, 0);

			priceWei = uint256(answer) * (10 ** (18 - feedDecimals));
			return (true, priceWei);
		} catch {
			return (false, 0);
		}
	}

	function _trackedTokenUsdPrices(
		ChainlinkPmmConfig memory cfg,
		uint256 poolPrice,
		uint256 token0Usd,
		uint256 token1Usd
	) internal pure returns (bool representable, uint256 oracleTrackedUsd, uint256 poolTrackedUsd) {
		// Accepted limit: `FullMath.mulDiv` reverts rather than saturating if the product genuinely
		// doesn't fit in 256 bits. That needs prices or a pool ratio many orders of magnitude
		// outside any real market, so it's out of scope rather than guarded with a `tryMulDiv`
		// wrapper.
		if (cfg.trackedTokenIsToken0) {
			oracleTrackedUsd = token0Usd;
			poolTrackedUsd = FullMath.mulDiv(poolPrice, token1Usd, WEI);
		} else {
			oracleTrackedUsd = token1Usd;
			poolTrackedUsd = FullMath.mulDiv(token0Usd, WEI, poolPrice);
		}
		representable = true;
	}

	function _directionalFee(
		ChainlinkPmmConfig memory cfg,
		uint256 oracleTrackedUsd,
		uint256 poolTrackedUsd,
		bool trackedTokenBought
	) internal pure returns (uint24) {
		if (oracleTrackedUsd == poolTrackedUsd) return cfg.baseFee;

		bool oracleAbovePool = oracleTrackedUsd > poolTrackedUsd;
		uint256 deviationBps = oracleAbovePool
			? FullMath.mulDiv(oracleTrackedUsd - poolTrackedUsd, BPS_DENOM, oracleTrackedUsd)
			: FullMath.mulDiv(poolTrackedUsd - oracleTrackedUsd, BPS_DENOM, oracleTrackedUsd);

		if (deviationBps <= cfg.neutralThresholdBps) return cfg.baseFee;

		bool applyPenalty = trackedTokenBought ? oracleAbovePool : !oracleAbovePool;
		if (applyPenalty) {
			uint256 feeDelta = _cappedFeeDelta(deviationBps, cfg.feePerDeviationBps, cfg.maxFee);
			uint256 increasedFee = feeDelta > cfg.baseFee ? feeDelta : cfg.baseFee;
			return increasedFee > cfg.maxFee ? cfg.maxFee : uint24(increasedFee);
		}

		uint256 discount = _cappedFeeDelta(deviationBps, cfg.feePerDeviationBps, cfg.baseFee);
		if (discount >= cfg.baseFee) return MIN_OVERRIDE_FEE;
		return uint24(uint256(cfg.baseFee) - discount);
	}

	function _cappedFeeDelta(uint256 deviationBps, uint24 feePerDeviationBps, uint24 cap) internal pure returns (uint256) {
		if (deviationBps == 0 || feePerDeviationBps == 0 || cap == 0) return 0;
		if (deviationBps > uint256(cap) / uint256(feePerDeviationBps)) return cap;
		return deviationBps * uint256(feePerDeviationBps);
	}

	/// @dev Prices the swap's clamped limit price too, so a swap that starts inside the neutral band
	/// but is allowed to walk far outside it doesn't get priced as if it stayed at spot.
	function _projectedLimitFee(
		ChainlinkPmmConfig memory cfg,
		uint160 sqrtPriceX96,
		SwapParams calldata params,
		bool trackedTokenBought,
		uint256 oracleTrackedUsd,
		uint256 token0Usd,
		uint256 token1Usd
	) internal view returns (uint24) {
		uint160 boundedLimit = _boundedSwapLimit(cfg, sqrtPriceX96, params);

		uint256 limitPoolPrice = _priceToken1PerToken0Wei(boundedLimit, token0Decimals, token1Decimals);
		if (limitPoolPrice == 0) return 0;

		(bool representable, , uint256 limitTrackedUsd) = _trackedTokenUsdPrices(cfg, limitPoolPrice, token0Usd, token1Usd);
		if (!representable || limitTrackedUsd == 0) return 0;

		return _directionalFee(cfg, oracleTrackedUsd, limitTrackedUsd, trackedTokenBought);
	}

	/// @dev The endpoint this swap is priced against, clamped into `maxLimitToSpotDeviationBps`
	/// around spot. `delta <= spot` is guaranteed because `maxLimitToSpotDeviationBps` is capped at
	/// `BPS_DENOM` in `_validatePmmConfig`, so the subtraction below can't underflow. A zero or
	/// wrong-side `sqrtPriceLimitX96` (routers commonly pass the pool's own min/max as "no limit")
	/// just means "no usable endpoint" — price the band edge instead of reverting.
	function _boundedSwapLimit(
		ChainlinkPmmConfig memory cfg,
		uint160 sqrtPriceX96,
		SwapParams calldata params
	) internal pure returns (uint160) {
		uint256 spot = sqrtPriceX96;
		uint256 delta = FullMath.mulDiv(spot, cfg.maxLimitToSpotDeviationBps, BPS_DENOM);

		uint256 edge = params.zeroForOne ? spot - delta : spot + delta;
		if (edge < TickMath.MIN_SQRT_PRICE) edge = TickMath.MIN_SQRT_PRICE;
		if (edge > TickMath.MAX_SQRT_PRICE) edge = TickMath.MAX_SQRT_PRICE;

		uint256 limit = params.sqrtPriceLimitX96;
		bool validDirection = params.zeroForOne ? limit < spot : limit > spot;
		if (limit == 0 || !validDirection) return uint160(edge);

		if (params.zeroForOne) return uint160(limit < edge ? edge : limit);
		return uint160(limit > edge ? edge : limit);
	}

	function _isPoolReferenceSafe(ChainlinkPmmConfig memory cfg, uint256 poolPrice) internal view returns (bool) {
		if (!_isPoolReferenceMature(cfg.minObservationAge)) return false;

		uint256 referencePrice = referencePoolPriceWei;
		uint256 absoluteDeviation = poolPrice > referencePrice ? poolPrice - referencePrice : referencePrice - poolPrice;
		uint256 deviationBps = FullMath.mulDiv(absoluteDeviation, BPS_DENOM, referencePrice);
		return deviationBps <= cfg.maxSpotToReferenceDeviationBps;
	}

	function _isPoolReferenceMature(uint32 minObservationAge) internal view returns (bool) {
		uint64 startedAt = observationStartedAt;
		if (referencePoolPriceWei == 0 || observationCount < MIN_MATURE_OBSERVATIONS || startedAt == 0 || block.timestamp < startedAt) {
			return false;
		}
		return block.timestamp - startedAt >= minObservationAge;
	}

	function _afterInitialize(address, PoolKey calldata key, uint160, int24) internal override returns (bytes4) {
		token0Decimals = _tokenDecimalsOrDefault(Currency.unwrap(key.currency0));
		token1Decimals = _tokenDecimalsOrDefault(Currency.unwrap(key.currency1));

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

	/// @dev A token that reverts on `decimals()` (or has none — e.g. this repo's own minimal
	/// `TestERC20` fixture) shouldn't block pool creation: it only feeds the PMM's price-normalization
	/// math, not swap solvency, so a wrong-but-conventional 18 is a safe default. Anything reporting
	/// more than 18 is clamped the same way, rather than reverting.
	function _tokenDecimalsOrDefault(address token) internal view returns (uint8) {
		try IERC20Metadata(token).decimals() returns (uint8 dec) {
			return dec <= 18 ? dec : 18;
		} catch {
			return 18;
		}
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

		bytes32 poolId = PoolId.unwrap(key.toId());

		bytes memory branchData = abi.encodeCall(
			this.runArbitrage,
			(poolId, params.zeroForOne, -delta.amount0(), -delta.amount1(), sender)
		);

		address(this).call{gas: callGasBudget}(branchData);

		return (BaseHook.afterSwap.selector, 0);
	}

	function _promotePendingObservation(uint32 observationWindow) internal {
		uint64 pendingBlock = pendingObservationBlock;
		if (pendingBlock == 0 || pendingBlock >= block.number) return;

		uint256 pendingPrice = pendingPoolPriceWei;
		uint64 pendingTimestamp = pendingObservationTimestamp;
		uint256 currentReference = referencePoolPriceWei;

		if (currentReference == 0) {
			referencePoolPriceWei = pendingPrice;
		} else {
			uint64 currentReferenceTimestamp = referenceTimestamp;
			uint256 elapsed = pendingTimestamp > currentReferenceTimestamp
				? uint256(pendingTimestamp - currentReferenceTimestamp)
				: 0;
			uint256 weightBps = elapsed >= observationWindow ? BPS_DENOM : FullMath.mulDiv(elapsed, BPS_DENOM, observationWindow);

			if (weightBps != 0) {
				if (pendingPrice >= currentReference) {
					referencePoolPriceWei = currentReference + FullMath.mulDiv(pendingPrice - currentReference, weightBps, BPS_DENOM);
				} else {
					referencePoolPriceWei = currentReference - FullMath.mulDiv(currentReference - pendingPrice, weightBps, BPS_DENOM);
				}
			}
		}

		referenceTimestamp = pendingTimestamp;
		if (observationCount != type(uint32).max) observationCount++;
		pendingPoolPriceWei = 0;
		pendingObservationBlock = 0;
		pendingObservationTimestamp = 0;
	}

	function _stagePendingObservation(uint256 poolPrice) internal {
		if (pendingObservationBlock == block.number) return;

		uint64 timestamp = uint64(block.timestamp);
		if (observationStartedAt == 0) observationStartedAt = timestamp;
		pendingPoolPriceWei = poolPrice;
		pendingObservationBlock = uint64(block.number);
		pendingObservationTimestamp = timestamp;
	}

	function _clearPmmObservations() internal {
		referencePoolPriceWei = 0;
		observationStartedAt = 0;
		referenceTimestamp = 0;
		observationCount = 0;
		pendingPoolPriceWei = 0;
		pendingObservationBlock = 0;
		pendingObservationTimestamp = 0;
	}

	/// @notice Converts a Uniswap v4 `sqrtPriceX96` into token1-per-token0, normalized to 18 decimals.
	/// @dev Accepted limits at both ends of the representable range: integer division truncates to 0
	/// once the true price falls below 1e-18 (callers already treat a zero price as "unusable"), and
	/// at the opposite extreme — a `sqrtPriceX96` near `TickMath.MAX_SQRT_PRICE`, i.e. one token worth
	/// roughly 2^128 of the other — the final `FullMath.mulDiv` can revert rather than return a value,
	/// since the true result no longer fits in 256 bits. Reverting the swap is the safe failure mode
	/// there, and the price ratio needed to reach it is far outside anything a real pool would hold.
	function _priceToken1PerToken0Wei(uint160 sqrtPriceX96, uint8 dec0, uint8 dec1) internal pure returns (uint256 priceWei) {
		uint256 scaledToken0Unit = (10 ** uint256(dec0)) * WEI;
		uint256 quoteToken1RawScaled;

		if (sqrtPriceX96 <= type(uint128).max) {
			uint256 ratioX192 = uint256(sqrtPriceX96) * sqrtPriceX96;
			quoteToken1RawScaled = FullMath.mulDiv(ratioX192, scaledToken0Unit, Q192);
		} else {
			uint256 ratioX128 = FullMath.mulDiv(uint256(sqrtPriceX96), uint256(sqrtPriceX96), Q64);
			quoteToken1RawScaled = FullMath.mulDiv(ratioX128, scaledToken0Unit, Q128);
		}

		priceWei = quoteToken1RawScaled / (10 ** uint256(dec1));
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
