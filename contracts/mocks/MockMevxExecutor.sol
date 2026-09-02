// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IMevxExecutor} from "../interfaces/IMevxExecutor.sol";

/// @dev Test double for IMevxExecutor. Never actually reached in the Chainlink fee
/// tests (MockMevxRouter always reports no arb opportunity) — implemented only to
/// satisfy the interface and the hook constructor's non-zero-address check.
contract MockMevxExecutor is IMevxExecutor {
	function executeRoute(bytes calldata, address[] memory, uint256, address) external override {}

	function executeRoute(bytes calldata, address[] memory, uint256, address, address) external override {}
}
