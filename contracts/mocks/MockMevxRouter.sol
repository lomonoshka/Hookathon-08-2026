// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IMevxRouter} from "../interfaces/IMevxRouter.sol";

/// @dev Test double for IMevxRouter. `initialArbCheck` always reports "no opportunity",
/// so the hook's existing arbitrage branch (runArbitrage) is a harmless no-op and tests
/// can exercise the Chainlink-driven dynamic fee logic in isolation.
contract MockMevxRouter is IMevxRouter {
	function initializePool(bytes32, uint16, bytes memory) external override {}

	function initializePoolExternally(bytes32, uint16, bytes memory) external override {}

	function initialArbCheck(
		bytes32,
		bool
	) external pure override returns (bool isArbPossible, bytes16 priceChange) {
		return (false, bytes16(0));
	}

	function constructArbitrageRoute(
		bytes32,
		bool,
		bytes16,
		int256,
		int256
	)
		external
		pure
		override
		returns (
			bool isArbPossible,
			address profitToken,
			address[] memory pools,
			uint256 optimalAmountIn,
			bytes memory encodedRoute
		)
	{
		return (false, address(0), new address[](0), 0, "");
	}

	function getMevProtectionFee(uint16) external pure override returns (uint24 pluginFee) {
		return 0;
	}
}
