// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @dev Minimal CREATE2 deployer used only in tests, to deploy HomelanderUniV4Plugin at a
/// mined address whose low bits encode the hook permission flags Uniswap v4 requires.
/// See helper-tools/uniswapV4/hookMiner.ts for the off-chain salt search.
contract Create2Factory {
	event Deployed(address addr);

	function deploy(bytes32 salt, bytes memory bytecode) external returns (address addr) {
		assembly {
			addr := create2(0, add(bytecode, 0x20), mload(bytecode), salt)
		}
		require(addr != address(0), "Create2Factory: deploy failed");
		emit Deployed(addr);
	}
}
