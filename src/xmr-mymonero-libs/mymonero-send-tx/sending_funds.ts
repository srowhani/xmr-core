// Copyright (c) 2014-2018, MyMonero.com
//
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without modification, are
// permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice, this list of
//	conditions and the following disclaimer.
//
// 2. Redistributions in binary form must reproduce the above copyright notice, this list
//	of conditions and the following disclaimer in the documentation and/or other
//	materials provided with the distribution.
//
// 3. Neither the name of the copyright holder nor the names of its contributors may be
//	used to endorse or promote products derived from this software without specific
//	prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY
// EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL
// THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
// PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT,
// STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF
// THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//

import {
	calculateFee,
	multiplyFeePriority,
	calculateFeeKb,
} from "./internal_libs/fee_utils";
import { minMixin } from "./mixin_utils";
import { Status, sendFundStatus } from "./status_update_constants";
import { ERR } from "./internal_libs/errors";
import { Log } from "./internal_libs/logger";
import { parseTargets } from "./internal_libs/parse_target";
import { checkAddressAndPidValidity } from "./internal_libs/pid_utils";

import {
	getRestOfTxData,
	createTxAndAttemptToSend,
} from "./internal_libs/construct_tx_and_send";
import { BigInt } from "biginteger";
import { estimateRctSize } from "xmr-transaction/libs/ringct";
import { formatMoneyFull } from "xmr-money/formatters";
import { NetType, RawTarget, Pid, ViewSendKeys } from "xmr-types";
import { MyMoneroApi } from "xmr-mymonero-libs/mymonero-api";
import { HWDevice } from "xmr-device/types";
import { selectOutputsAndAmountForMixin } from "./internal_libs/output_selection";

export function estimatedTransactionNetworkFee(
	nonZeroMixin: number,
	feePerKB: BigInt,
	simplePriority: number,
) {
	const numOfInputs = 2; // this might change -- might select inputs
	const numOfOutputs =
		1 /*dest*/ + 1 /*change*/ + 0; /*no mymonero fee presently*/
	// TODO: update est tx size for bulletproofs
	// TODO: normalize est tx size fn naming
	const estimatedTxSize = estimateRctSize(
		numOfInputs,
		nonZeroMixin,
		numOfOutputs,
	);
	const estFee = calculateFee(
		feePerKB,
		estimatedTxSize,
		multiplyFeePriority(simplePriority),
	);

	return estFee;
}

export type SendFundsRet = {
	targetAddress: string;
	sentAmount: number;
	pid: Pid;
	txHash: string;
	txFee: BigInt;
};

export async function sendFunds(
	targetAddress: string, // currency-ready wallet address, but not an OpenAlias address (resolve before calling)
	nettype: NetType,
	amountOrZeroWhenSweep: number, // n value will be ignored for sweep
	isSweeping: boolean, // send true to sweep - amountorZeroWhenSweep will be ignored
	senderAddress: string,
	senderPrivateKeys: ViewSendKeys,
	senderPublicKeys: ViewSendKeys,
	pidToParse: Pid,
	mixin: number,
	simplePriority: number,
	hwdev: HWDevice,
	updateStatus: (status: Status) => void,
	outputAndAmountSelector = selectOutputsAndAmountForMixin,
	api = MyMoneroApi,
): Promise<SendFundsRet> {
	const isRingCT = true;

	if (mixin < minMixin()) {
		throw ERR.RING.INSUFF;
	}

	// parse & normalize the target descriptions by mapping them to Monero addresses & amounts
	const targetAmount = isSweeping ? 0 : amountOrZeroWhenSweep;
	const target: RawTarget = {
		address: targetAddress,
		amount: targetAmount,
	};
	const [singleTarget] = parseTargets(
		[target], // requires a list of descriptions - but SendFunds was
		// not written with multiple target support as MyMonero does not yet support it
		nettype,
	);

	if (!singleTarget) {
		throw ERR.DEST.INVAL;
	}

	const { address, amount } = singleTarget;
	const feelessTotal = new BigInt(amount);

	Log.Amount.beforeFee(feelessTotal, isSweeping);

	if (!isSweeping && feelessTotal.compare(0) <= 0) {
		throw ERR.AMT.INSUFF;
	}

	const pidData = checkAddressAndPidValidity(address, nettype, pidToParse);

	updateStatus(sendFundStatus.fetchingLatestBalance);

	const { per_kb_fee: feePerKB, unusedOuts } = await api.unspentOutputs(
		senderAddress,

		senderPrivateKeys.view,
		senderPublicKeys.spend,
		senderPrivateKeys.spend,

		mixin,
		hwdev,
	);

	// Transaction will need at least 1KB fee (or 13KB for RingCT)
	const minNetworkTxSizeKb = /*isRingCT ? */ 13; /* : 1*/
	const estMinNetworkFee = calculateFeeKb(
		feePerKB,
		minNetworkTxSizeKb,
		multiplyFeePriority(simplePriority),
	);

	// construct commonly used parameters
	const senderkeys = {
		senderAddress,
		senderPublicKeys,
		senderPrivateKeys,
	};

	const targetData = {
		targetAddress,
		targetAmount,
	};

	const feeMeta = {
		simplePriority,
		feelessTotal,
		feePerKB, // obtained from server, so passed in
	};

	const txMeta = {
		isRingCT,
		isSweeping,
		nettype,
	};

	const externApis = {
		updateStatus,
		api,
	};

	// begin the network fee with the smallest fee possible
	let networkFee = estMinNetworkFee;

	// this loop should only execute at most twice
	// 1st execution to generate the inital transaction
	// 2nd execution if the initial transaction's fee is greater than
	// what the predicted tx fee would be
	while (true) {
		// now we're going to try using this minimum fee but the function will be called again
		// if we find after constructing the whole tx that it is larger in kb than
		// the minimum fee we're attempting to send it off with
		const {
			mixOuts,
			fundTargets,
			newFee,
			usingOuts,
		} = await getRestOfTxData(
			{
				...senderkeys,
				...targetData,

				mixin,
				unusedOuts,

				...feeMeta,
				networkFee,

				...txMeta,
				...externApis,
			},
			outputAndAmountSelector,
		);
		networkFee = newFee; // reassign network fee to the new fee returned

		const { txFee, txHash, success } = await createTxAndAttemptToSend({
			...senderkeys,
			...targetData,
			fundTargets,
			...pidData,

			mixin,
			mixOuts,
			usingOuts,

			...feeMeta,
			networkFee,

			...txMeta,
			...externApis,
			hwdev,
		});

		if (success) {
			const sentAmount = isSweeping
				? parseFloat(formatMoneyFull(feelessTotal))
				: targetAmount;

			return {
				pid: pidData.pid,
				sentAmount,
				targetAddress,
				txFee,
				txHash,
			};
		} else {
			// if the function call failed
			// means that we need a higher fee that was returned
			// so reassign network fee to it
			networkFee = txFee;
		}
	}
}
