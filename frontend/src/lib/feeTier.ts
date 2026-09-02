const FEE_PIPS_MASK = 0x7fffff; // masks off LPFeeLibrary.OVERRIDE_FEE_FLAG / dynamic-fee flag bit

/** Extracts the baseFee/defaultFeePips a hook's `dynamicFee` constructor arg encodes, from
 * `dynamicFee & 0x7FFFFF` — the same mask HomelanderUniV4PluginChainlinkPmm._feeForSender uses. */
export function defaultFeePipsFrom(dynamicFee: number | undefined): number | null {
	if (dynamicFee === undefined) return null;
	return dynamicFee & FEE_PIPS_MASK;
}

/** Uniswap fee pips are millionths (1_000_000 = 100%). */
export function formatFeePips(pips: number | null | undefined): string {
	if (pips === null || pips === undefined) return "—";
	return `${(pips / 10_000).toFixed(3)}%`;
}
