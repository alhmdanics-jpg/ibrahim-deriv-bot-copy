import { LogTypes } from '../../../constants/messages';
import { api_base } from '../../api/api-base';
import { contractStatus, info, log } from '../utils/broadcast';
import { doUntilDone, getUUID, recoverFromError, tradeOptionToBuy } from '../utils/helpers';
import { purchaseSuccessful } from './state/actions';
import { BEFORE_PURCHASE } from './state/constants';

let delayIndex = 0;
let purchase_reference;
const invertBarrierOffset = value => {
    if (typeof value !== 'string') return value;
    if (value.startsWith('+')) return `-${value.slice(1)}`;
    if (value.startsWith('-')) return `+${value.slice(1)}`;
    return value;
};

export default Engine =>
    class Purchase extends Engine {
        purchase(contract_type) {
            // Prevent calling purchase twice.
            if (this.store.getState().scope !== BEFORE_PURCHASE) {
                return Promise.resolve();
            }

            this.contractIds = [];
            this.contractStates = {};
            this.contractsByType = {};
            this.isBothPurchase = contract_type === 'both';

            if (this.isBothPurchase) {
                const contract_types = this.options?.contractTypes || [];
                if (contract_types.length !== 2 || new Set(contract_types).size !== 2) {
                    return Promise.reject(new Error('Both requires two distinct contract types'));
                }

                this.isSold = false;
                this.contractId = '';
                this.bothResultProcessed = false;
                this.bothOpenDispatched = false;
                this.bothPurchasesSettled = false;
                contractStatus({ id: 'contract.purchase_sent', data: this.tradeOptions.amount });

                // Start both requests in this same execution turn; independent API requests
                // cannot guarantee an identical market entry spot.
                let purchase_requests;
                try {
                    purchase_requests = contract_types.map(type => {
                        const proposal = this.is_proposal_subscription_required ? this.selectProposal(type) : null;
                        const trade_options = { ...this.tradeOptions };
                        if (type === 'HIGHER') {
                            trade_options.barrierOffset = invertBarrierOffset(trade_options.barrierOffset);
                            trade_options.secondBarrierOffset = undefined;
                        } else if (type === 'LOWER') {
                            trade_options.barrierOffset = invertBarrierOffset(this.tradeOptions.secondBarrierOffset);
                            trade_options.secondBarrierOffset = undefined;
                        }
                        const trade_option = proposal ? null : tradeOptionToBuy(type, trade_options);
                        const action = () =>
                            proposal
                                ? api_base.api.send({ buy: proposal.id, price: proposal.askPrice })
                                : api_base.api.send(trade_option);

                        return { type, action };
                    });
                } catch (error) {
                    this.$scope?.observer?.emit('Error', error?.error || error);
                    return Promise.reject(error);
                }

                const purchases = purchase_requests.map(({ type, action }) => {
                    return doUntilDone(action).then(response => {
                        const buy = response?.buy;
                        if (!buy?.contract_id) {
                            throw new Error(`${type} buy response has no contract_id`);
                        }

                        this.contractsByType[type] = {
                            contract_id: buy.contract_id,
                            contract_type: type,
                            buy,
                        };
                        this.contractIds.push(buy.contract_id);
                        return { type, response };
                    });
                });

                return Promise.allSettled(purchases).then(settled => {
                    const failures = settled.filter(result => result.status === 'rejected');
                    const successes = settled.filter(result => result.status === 'fulfilled');

                    successes.forEach(result => {
                        const { type, response } = result.value;
                        const buy = response?.buy;
                        contractStatus({ id: 'contract.purchase_received', data: buy.transaction_id, buy });
                        log(LogTypes.PURCHASE, { longcode: buy.longcode, transaction_id: buy.transaction_id });
                    });

                    if (failures.length > 0 || successes.length !== contract_types.length) {
                        const error = failures[0]?.reason || new Error('Both purchase did not complete successfully');
                        failures.forEach(result => {
                            const failure = result.reason?.error || result.reason;
                            // eslint-disable-next-line no-console
                            console.error('[Both] Contract purchase failed:', failure);
                            this.$scope?.observer?.emit('Error', failure);
                        });
                        if (failures.length === 0) this.$scope?.observer?.emit('Error', error);
                        return Promise.reject(error);
                    }

                    this.bothPurchasesSettled = true;
                    this.updateAndReturnTotalRuns();
                    delayIndex = 0;
                    this.store.dispatch(purchaseSuccessful());
                    this.checkBothContracts();

                    return successes.map(result => result.value.response);
                });
            }

            this.isBothPurchase = false;

    const onSuccess = response => {
                // Don't unnecessarily send a forget request for a purchased contract.
                const { buy } = response;

                contractStatus({
                    id: 'contract.purchase_received',
                    data: buy.transaction_id,
                    buy,
                });

                 this.contractId = buy.contract_id;
this.store.dispatch(purchaseSuccessful());               

                if (this.is_proposal_subscription_required) {
                    this.renewProposalsOnPurchase();
                }

                delayIndex = 0;
                log(LogTypes.PURCHASE, { longcode: buy.longcode, transaction_id: buy.transaction_id });
                info({
                    accountID: this.accountInfo.loginid,
                    totalRuns: this.updateAndReturnTotalRuns(),
                    transaction_ids: { buy: buy.transaction_id },
                    contract_type,
                    buy_price: buy.buy_price,
                });
                return response;
            };

            if (this.is_proposal_subscription_required) {
                const { id, askPrice } = this.selectProposal(contract_type);

                const action = () => api_base.api.send({ buy: id, price: askPrice });

                this.isSold = false;

                contractStatus({
                    id: 'contract.purchase_sent',
                    data: askPrice,
                });

                if (!this.options.timeMachineEnabled) {
                    return doUntilDone(action).then(onSuccess);
                }

                return recoverFromError(
                    action,
                    (errorCode, makeDelay) => {
                        // if disconnected no need to resubscription (handled by live-api)
                        if (errorCode !== 'DisconnectError') {
                            this.renewProposalsOnPurchase();
                        } else {
                            this.clearProposals();
                        }

                        const unsubscribe = this.store.subscribe(() => {
                            const { scope, proposalsReady } = this.store.getState();
                            if (scope === BEFORE_PURCHASE && proposalsReady) {
                                makeDelay().then(() => this.observer.emit('REVERT', 'before'));
                                unsubscribe();
                            }
                        });
                    },
                    ['PriceMoved', 'InvalidContractProposal'],
                    delayIndex++
                ).then(onSuccess);
            }
            const trade_option = tradeOptionToBuy(contract_type, this.tradeOptions);
            const action = () => api_base.api.send(trade_option);

            this.isSold = false;

            contractStatus({
                id: 'contract.purchase_sent',
                data: this.tradeOptions.amount,
            });

            if (!this.options.timeMachineEnabled) {
                return doUntilDone(action).then(onSuccess);
            }

            return recoverFromError(
                action,
                (errorCode, makeDelay) => {
                    if (errorCode === 'DisconnectError') {
                        this.clearProposals();
                    }
                    const unsubscribe = this.store.subscribe(() => {
                        const { scope } = this.store.getState();
                        if (scope === BEFORE_PURCHASE) {
                            makeDelay().then(() => this.observer.emit('REVERT', 'before'));
                            unsubscribe();
                        }
                    });
                },
                ['PriceMoved', 'InvalidContractProposal'],
                delayIndex++
            ).then(onSuccess);
        }
        getPurchaseReference = () => purchase_reference;
        regeneratePurchaseReference = () => {
            purchase_reference = getUUID();
        };
    };
