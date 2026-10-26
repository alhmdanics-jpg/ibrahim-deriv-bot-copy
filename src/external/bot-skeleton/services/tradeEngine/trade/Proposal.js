import { localize } from '@deriv-com/translations';
import { api_base } from '../../api/api-base';
import { doUntilDone, tradeOptionToProposal } from '../utils/helpers';
import { isHigherLowerPair } from '../utils/pair-payout-validation';
import { clearProposals, proposalsReady } from './state/actions';

const PAIR_PROPOSAL_REQUEST_TIMEOUT_MS = 15000;
const PAIR_PROPOSAL_FAILURE_CODE = 'PairProposalFailure';

const getResponseData = response => {
    if (!response?.data || typeof response.data !== 'object') return response;

    return {
        ...response,
        ...response.data,
        echo_req: response.data.echo_req ?? response.echo_req,
        passthrough: response.data.passthrough ?? response.passthrough,
    };
};

const getResponsePassthrough = response =>
    response?.passthrough ?? response?.echo_req?.passthrough;

const getResponsePassthroughs = response =>
    [
        { label: 'passthrough', value: response?.passthrough },
        { label: 'echo_req.passthrough', value: response?.echo_req?.passthrough },
    ].filter(({ value }) => value && typeof value === 'object');

const getSafePassthrough = passthrough => {
    if (!passthrough || typeof passthrough !== 'object') return null;

    return {
        contract_type: passthrough.contract_type ?? null,
        purchase_reference: passthrough.purchase_reference ?? null,
    };
};

const getPairProposalDiagnostic = (response, current_purchase_reference) => {
    const response_data = getResponseData(response);
    const echoed_request = response_data?.echo_req;

    return JSON.stringify({
        msg_type: response_data?.msg_type ?? null,
        echo_req: {
            proposal: echoed_request?.proposal ?? null,
            contract_type: echoed_request?.contract_type ?? null,
        },
        passthrough: {
            response: getSafePassthrough(response_data?.passthrough),
            echo_req: getSafePassthrough(echoed_request?.passthrough),
        },
        current_purchase_reference: current_purchase_reference ?? null,
    });
};

const createPairProposalCancellationError = () => {
    const error = new Error('Higher/Lower pair proposal request was cancelled.');
    error.code = 'PairProposalCancelled';
    return error;
};

export default Engine =>
    class Proposal extends Engine {
        makeProposals(trade_option) {
            if (!this.isNewTradeOption(trade_option)) {
                return;
            }

            // Generate a purchase reference when trade options are different from previous trade options.
            // This will ensure the bot doesn't mistakenly purchase the wrong proposal.
            this.regeneratePurchaseReference();
            this.trade_option = trade_option;
            this.proposal_templates = tradeOptionToProposal(trade_option, this.getPurchaseReference());
            this.renewProposalsOnPurchase();
        }

        selectProposal(contract_type) {
            const { proposals } = this.data;

            if (proposals.length === 0) {
                throw Error(localize('Proposals are not ready'));
            }

            const to_buy = proposals.find(proposal => {
                if (
                    proposal.contract_type === contract_type &&
                    proposal.purchase_reference === this.getPurchaseReference()
                ) {
                    // Below happens when a user has had one of the proposals return
                    // with a ContractBuyValidationError. We allow the logic to continue
                    // to here cause the opposite proposal may still be valid. Only once
                    // they attempt to purchase the errored proposal we will intervene.
                    if (proposal.error) {
                        throw proposal.error;
                    }

                    return proposal;
                }

                return false;
            });

            if (!to_buy) {
                throw new Error(localize('Selected proposal does not exist'));
            }

            return {
                id: to_buy.id,
                askPrice: to_buy.ask_price,
            };
        }

        renewProposalsOnPurchase() {
            this.data.proposals = [];
            this.store.dispatch(clearProposals());
            this.requestProposals();
        }

        requestProposals() {
            // Since there are two proposals (in most cases), an error may be logged twice, to avoid this
            // flip this boolean on error.
            let has_informed_error = false;
            const is_higher_lower_pair = isHigherLowerPair(this.options?.contractTypes);
            let pair_attempt;

            if (is_higher_lower_pair) {
                this.cancelPendingProposalRequests();
                pair_attempt = this.createPairProposalAttempt();
                this.pendingPairProposalAttempt = pair_attempt;
            }

            const proposal_requests = this.proposal_templates.map(proposal => {
                const request = is_higher_lower_pair
                    ? this.requestPairProposal(proposal, pair_attempt)
                    : doUntilDone(() => api_base.api.send(proposal));

                return Promise.resolve(request)
                    .then(response => {
                        if (!is_higher_lower_pair) return response;
                        if (pair_attempt.cancelled) return null;

                        const response_data = getResponseData(response);
                        if (response_data?.error) throw response_data;
                        this.validatePairProposalResponse(response_data, proposal);
                        if (pair_attempt.cancelled) return null;
                        this.addProposalResponse(response_data, false);
                        this.checkProposalReady();
                        return response;
                    })
                    .catch(error => {
                        if (is_higher_lower_pair) {
                            if (pair_attempt.cancelled || pair_attempt.failure_reported) return null;

                            pair_attempt.failure_reported = true;
                            const proposal_error =
                                error?.code === PAIR_PROPOSAL_FAILURE_CODE
                                    ? error
                                    : this.createPairProposalFailure(error, proposal);
                            proposal_error.code = PAIR_PROPOSAL_FAILURE_CODE;
                            this.cancelPendingProposalRequests(pair_attempt);
                            this.$scope?.observer?.emit('Error', proposal_error);

                            return null;
                        }

                        // We intercept ContractBuyValidationError as user may have specified
                        // e.g. a DIGITUNDER 0 or DIGITOVER 9, while one proposal may be invalid
                        // the other is valid. We will error on Purchase rather than here.

                        if (error?.error?.code === 'ContractBuyValidationError') {
                            this.data.proposals.push({
                                ...error.error.echo_req,
                                ...error.echo_req.passthrough,
                                error,
                            });

                            return null;
                        }
                        if (!has_informed_error) {
                            has_informed_error = true;
                            this.$scope.observer.emit('Error', error.error);
                        }
                        return null;
                    });
            });

            const proposals_promise = Promise.all(proposal_requests);
            if (is_higher_lower_pair) {
                return proposals_promise.finally(() => {
                    if (this.pendingPairProposalAttempt === pair_attempt) {
                        this.pendingPairProposalAttempt = null;
                    }
                });
            }
        }

        createPairProposalAttempt() {
            let reject_cancellation;
            const attempt = {
                cancelled: false,
                failure_reported: false,
                cancellation_promise: new Promise((_, reject) => {
                    reject_cancellation = reject;
                }),
            };

            attempt.cancel = () => {
                if (attempt.cancelled) return;
                attempt.cancelled = true;
                reject_cancellation(createPairProposalCancellationError());
            };

            return attempt;
        }

        cancelPendingProposalRequests(attempt = this.pendingPairProposalAttempt) {
            if (!attempt || this.pendingPairProposalAttempt !== attempt) return;

            this.pendingPairProposalAttempt = null;
            attempt.cancel();
        }

        createPairProposalFailure(error, proposal) {
            const api_error = error?.error || error;
            const code = api_error?.code || error?.code;
            const message = api_error?.message || error?.message || localize('No response was received');
            const diagnostic = getPairProposalDiagnostic(error, this.getPurchaseReference());
            const proposal_error = new Error(
                `${proposal.contract_type} proposal failed${code ? ` (${code})` : ''}: ${message}. ` +
                    `Response details: ${diagnostic}`
            );
            proposal_error.code = PAIR_PROPOSAL_FAILURE_CODE;
            if (code) proposal_error.deriv_error_code = code;
            return proposal_error;
        }

        requestPairProposal(proposal, attempt) {
            let timeout_id;
            const send_promise = Promise.resolve().then(() => {
                if (attempt.cancelled) throw createPairProposalCancellationError();
                if (!api_base.api?.send) {
                    throw new Error('Deriv API is unavailable for proposal requests.');
                }
                return api_base.api.send(proposal);
            });
            const timeout_promise = new Promise((_, reject) => {
                timeout_id = setTimeout(() => {
                    const timeout_seconds = PAIR_PROPOSAL_REQUEST_TIMEOUT_MS / 1000;
                    const timeout_message =
                        `Timed out waiting for the ${proposal.contract_type} proposal response` +
                        ` after ${timeout_seconds} seconds.`;
                    const error = new Error(timeout_message);
                    error.code = 'ProposalTimeout';
                    reject(error);
                }, PAIR_PROPOSAL_REQUEST_TIMEOUT_MS);
            });

            return Promise.race([send_promise, timeout_promise, attempt.cancellation_promise]).finally(() =>
                clearTimeout(timeout_id)
            );
        }

        validatePairProposalResponse(response, template) {
            const { contract_type, passthrough } = template;
            const echoed_request = response?.echo_req;
            const echoed_passthroughs = getResponsePassthroughs(response);
            const current_purchase_reference = this.getPurchaseReference();
            const validation_errors = [];

            if (response?.msg_type !== 'proposal') {
                validation_errors.push(`msg_type was ${JSON.stringify(response?.msg_type ?? null)}, expected "proposal"`);
            }
            if (!response?.proposal?.id) validation_errors.push('proposal.id is missing');
            if (echoed_request?.proposal !== 1) {
                validation_errors.push(`echo_req.proposal was ${JSON.stringify(echoed_request?.proposal ?? null)}, expected 1`);
            }
            if (echoed_request?.contract_type !== contract_type) {
                validation_errors.push(
                    `echo_req.contract_type was ${JSON.stringify(echoed_request?.contract_type ?? null)}, ` +
                        `expected ${contract_type}`
                );
            }
            if (echoed_passthroughs.length === 0) validation_errors.push('passthrough is missing');

            echoed_passthroughs.forEach(({ label: passthrough_label, value: echoed_passthrough }) => {
                if (echoed_passthrough.contract_type !== contract_type) {
                    validation_errors.push(
                        `${passthrough_label}.contract_type was ${JSON.stringify(echoed_passthrough.contract_type ?? null)}, ` +
                            `expected ${contract_type}`
                    );
                }
                if (echoed_passthrough.purchase_reference !== passthrough?.purchase_reference) {
                    validation_errors.push(`${passthrough_label}.purchase_reference does not match the request template`);
                }
                if (echoed_passthrough.purchase_reference !== current_purchase_reference) {
                    validation_errors.push(
                        `${passthrough_label}.purchase_reference does not match ` +
                            'the current purchase reference'
                    );
                }
            });

            if (validation_errors.length > 0) {
                const diagnostic = getPairProposalDiagnostic(response, current_purchase_reference);
                const error = new Error(
                    `${contract_type} proposal response rejected: ${validation_errors.join('; ')}. ` +
                        `Response details: ${diagnostic}`
                );
                error.code = PAIR_PROPOSAL_FAILURE_CODE;
                throw error;
            }
        }

        addProposalResponse(response, should_check_readiness = true) {
            const response_data = getResponseData(response);
            const { passthrough, proposal } = response_data || {};
            const response_passthrough = passthrough ?? getResponsePassthrough(response_data);

            if (response_data?.msg_type !== 'proposal' || !proposal || !response_passthrough) return;

            const proposal_with_passthrough = { ...proposal, ...response_passthrough };
            const existing_proposal_index = this.data.proposals.findIndex(item => item.id === proposal.id);

            if (existing_proposal_index === -1) {
                this.data.proposals.push(proposal_with_passthrough);
            }

            if (should_check_readiness) this.checkProposalReady();
        }

        observeProposals() {
            if (!api_base.api) return;
            const is_higher_lower_pair = isHigherLowerPair(this.options?.contractTypes);
            api_base.subscribeToMessages(response => {
                const response_data = getResponseData(response);
                if (!is_higher_lower_pair && response_data?.msg_type === 'proposal') {
                    this.addProposalResponse(response_data);
                }
            });
        }

        checkProposalReady() {
            // Proposals are considered ready when the proposals in our memory match the ones
            // we've requested from the API, we determine this by checking the passthrough of the response.
            const { proposals } = this.data;

            if (proposals.length > 0 && this.proposal_templates) {
                const has_equal_proposals = this.proposal_templates.every(template => {
                    return (
                        proposals.findIndex(proposal => {
                            return (
                                proposal.purchase_reference === template.passthrough.purchase_reference &&
                                proposal.contract_type === template.contract_type
                            );
                        }) !== -1
                    );
                });

                if (has_equal_proposals) {
                    this.startPromise.then(() => this.store.dispatch(proposalsReady()));
                }
            }
        }

        isNewTradeOption(trade_option) {
            if (!this.trade_option) {
                this.trade_option = trade_option;
                return true;
            }

            // Compare incoming "trade_option" argument with "this.trade_option", if any
            // of the values is different, this is a new tradeOption and new proposals
            // should be generated.
            return [
                'amount',
                'barrierOffset',
                'basis',
                'duration',
                'duration_unit',
                'prediction',
                'secondBarrierOffset',
                'symbol',
            ].some(value => this.trade_option[value] !== trade_option[value]);
        }
    };
