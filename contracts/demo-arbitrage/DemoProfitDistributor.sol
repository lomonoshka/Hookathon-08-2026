// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Hackathon-original profit distributor. Forwards whatever captured-arbitrage token
/// balance it holds to a single configured LP recipient and logs it per configId, so the demo
/// dashboard can show captured-MEV history. This is a deliberate simplification of Homelander's
/// production pro-rata multi-recipient share system (kept private) — written from scratch.
contract DemoProfitDistributor is Ownable {
	address public lpRecipient;
	mapping(bytes32 => uint256) public totalDistributed;

	event LpRecipientSet(address oldRecipient, address newRecipient);
	event ProfitDistributed(bytes32 indexed configId, address indexed token, address indexed swapRecipient, uint256 amount);

	constructor(address lpRecipient_, address owner_) {
		require(lpRecipient_ != address(0), "lpRecipient is zero address");
		lpRecipient = lpRecipient_;
		_transferOwnership(owner_);
	}

	function setLpRecipient(address _lpRecipient) external onlyOwner {
		require(_lpRecipient != address(0), "lpRecipient is zero address");
		emit LpRecipientSet(lpRecipient, _lpRecipient);
		lpRecipient = _lpRecipient;
	}

	function distributeProfit(bytes32 configId, address token, address swapRecipient) public {
		uint256 amount = IERC20(token).balanceOf(address(this));
		if (amount == 0) {
			return;
		}
		totalDistributed[configId] += amount;
		IERC20(token).transfer(lpRecipient, amount);
		emit ProfitDistributed(configId, token, swapRecipient, amount);
	}

	function distributeProfit(bytes32 configId, address token) external {
		distributeProfit(configId, token, address(0));
	}
}
