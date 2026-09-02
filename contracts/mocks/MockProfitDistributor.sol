// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import {IProfitDistributor} from "../interfaces/IProfitDistributor.sol";

/// @dev Test double for IProfitDistributor. Unreached in the Chainlink fee tests —
/// implemented only to satisfy the interface and the hook constructor's non-zero-address check.
contract MockProfitDistributor is IProfitDistributor {
	function distributeProfit(bytes32, address, address) external override {}

	function distributeProfit(bytes32, address) external override {}
}
