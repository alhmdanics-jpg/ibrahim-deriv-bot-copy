import { LogTypes } from '../../../constants/messages';
import { observer as globalObserver } from '../../../utils/observer';
import { api_base } from '../../api/api-base';
import { contractStatus, log } from '../utils/broadcast';
import { doUntilDone, recoverFromError } from '../utils/helpers';
import { DURING_PURCHASE } from './state/constants';

export default Engine =>
    class Sell extends Engine {
        isSellAtMarketAvailable() {
            if (this.isBothPurchase) {
                return Object.values(this.contractsByType || {}).some(({ contract_id }) => {
                    const contract = this.contractStates?.[contract_id];
                    return contract && !contract.is_sold && contract.is_valid_to_sell && !contract.is_expired;
                });
            }
            return this.contractId && !this.isSold && this.isSellAvailable && !this.isExpired;
        }

        sellAtMarket() {
            globalObserver.emit('bot.sell');

            // Prevent calling sell twice
            if (this.store.getState().scope !== DURING_PURCHASE) {
                return Promise.resolve();
            }

            if (!this.isSellAtMarketAvailable()) {
                log(LogTypes.NOT_OFFERED);
                return Promise.resolve();
            }

            if (this.isBothPurchase) {
                return this.sellBothAtMarket();
            }

            let delay_index = 1;

            return new Promise(resolve => {
                const onContractSold = sell_response => {
                    delay_index = 1;

                    if (sell_response) {
                        const { sold_for } = sell_response.sell;
                        log(LogTypes.SELL, { sold_for });
                    }

                    contractStatus('purchase.sold');
                    this.waitForAfter();
                    resolve();
                };

                const contract_id = this.contractId;

                const sellContractAndGetContractInfo = () => {
                    return doUntilDone(() => api_base.api.send({ sell: contract_id, price: 0 }))
                        .then(sell_response => {
                            doUntilDone(() => api_base.api.send({ proposal_open_contract: 1, contract_id })).then(
                                () => sell_response
                            );
                        })
                        .catch(e => {
                            const error = e.error;
                            if (error.code === 'InvalidOfferings') {
                                // "InvalidOfferings" may occur when user tries to sell the contract too close
                                // to the expiry time. We shouldn't interrupt the bot but instead let the contract
                                // finish.
                                return Promise.resolve();
                            }

                            const sell_error = {
                                name: error.code,
                                message: error.message,
                                msg_type: e.msg_type,
                                error: { ...error.error },
                            };

                            if (error.code === 'RateLimit') {
                                return Promise.reject(sell_error);
                            }

                            // For every other error, check whether the contract is not actually already sold.
                            return doUntilDone(() =>
                                api_base.api.send({
                                    proposal_open_contract: 1,
                                    contract_id,
                                })
                            ).then(proposal_open_contract_response => {
                                const { proposal_open_contract } = proposal_open_contract_response;

                                if (!proposal_open_contract.is_sold) {
                                    return Promise.reject(sell_error);
                                }

                                // If the contract is sold at this point it means there was a race condition.
                                // Pretend this sell request was successful and mislead the trade engine into
                                // moving onto the next scope.
                                return Promise.resolve({
                                    sell: {
                                        sold_for: proposal_open_contract.sell_price,
                                    },
                                });
                            });
                        });
                };

                const errors_to_ignore = ['NoOpenPosition', 'InvalidSellContractProposal', 'UnrecognisedRequest'];

                // Restart buy/sell on error is enabled, don't recover from sell error.
                if (!this.options.timeMachineEnabled) {
                    // eslint-disable-next-line no-promise-executor-return
                    return doUntilDone(sellContractAndGetContractInfo, errors_to_ignore)
                        .then(sell_response => onContractSold(sell_response))
                        .catch(error => error);
                }

                // If above checkbox not checked, try to recover from sell error.
                const recoverFn = (error_code, makeDelay) => {
                    return makeDelay().then(() => this.observer.emit('REVERT', 'during'));
                };
                // eslint-disable-next-line no-promise-executor-return
                return recoverFromError(
                    sellContractAndGetContractInfo,
                    recoverFn,
                    errors_to_ignore,
                    delay_index++
                ).then(sell_response => onContractSold(sell_response));
            });
        }

        sellBothAtMarket() {
            const sellableContracts = Object.values(this.contractsByType || {}).filter(({ contract_id }) => {
                const contract = this.contractStates?.[contract_id];
                return contract && !contract.is_sold && contract.is_valid_to_sell && !contract.is_expired;
            });

            if (sellableContracts.length === 0) {
                log(LogTypes.NOT_OFFERED);
                return Promise.resolve([]);
            }

            this.waitForAfter();

            const sellRequests = sellableContracts.map(({ contract_id, contract_type }) =>
                doUntilDone(() => api_base.api.send({ sell: contract_id, price: 0 }))
                    .then(response =>
                        doUntilDone(() => api_base.api.send({ proposal_open_contract: 1, contract_id })).then(
                            () => response
                        )
                    )
                    .catch(error => {
                        if (error?.error?.code === 'InvalidOfferings') return undefined;

                        return doUntilDone(() =>
                            api_base.api.send({ proposal_open_contract: 1, contract_id })
                        ).then(({ proposal_open_contract }) => {
                            if (!proposal_open_contract?.is_sold) return Promise.reject(error);
                            return { sell: { sold_for: proposal_open_contract.sell_price } };
                        });
                    })
                    .then(response => {
                        if (response?.sell) {
                            log(LogTypes.SELL, { sold_for: response.sell.sold_for, contract_type });
                        }
                        return { contract_id, contract_type, response };
                    })
            );

            return Promise.allSettled(sellRequests).then(results => {
                results.forEach(result => {
                    if (result.status === 'rejected') {
                        const error = result.reason?.error || result.reason;
                        // eslint-disable-next-line no-console
                        console.error('[Both] Contract sell failed:', error);
                        this.$scope?.observer?.emit('Error', error);
                    }
                });
                // OpenContract completes the round only after every purchased leg is settled.
                return results;
            });
        }
    };
