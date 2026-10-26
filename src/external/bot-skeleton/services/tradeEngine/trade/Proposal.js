import { localize } from '@deriv-com/translations';
import { api_base } from '../../api/api-base';
import { doUntilDone, tradeOptionToProposal } from '../utils/helpers';
import { isHigherLowerPair } from '../utils/pair-payout-validation';
import { clearProposals, proposalsReady } from './state/actions';

const PAIR_PROPOSAL_REQUEST_TIMEOUT_MS = 15000;

const getResponseData = response => response?.data ?? response;

const getResponsePassthrough = response =>
    response?.passthrough ?? response?.echo_req?.passthrough;

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

            const proposal_requests = this.proposal_templates.map(proposal => {
                const request = is_higher_lower_pair
                    ? this.requestPairProposal(proposal)
                    : doUntilDone(() => api_base.api.send(proposal));

                return Promise.resolve(request)
                    .then(response => {
                        if (!is_higher_lower_pair) return response;

                        const response_data = getResponseData(response);
                        if (response_data?.error) throw response_data;
                        this.validatePairProposalResponse(response_data, proposal);
                        this.addProposalResponse(response_data, false);
                        this.checkProposalReady();
                        return response;
                    })
                    .catch(error => {
                        if (is_higher_lower_pair) {
                            if (!has_informed_error) {
                                has_informed_error = true;
                                const api_error = error?.error || error;
                                const code = api_error?.code || error?.code;
                                const message =
                                    api_error?.message || error?.message || localize('No response was received');
                                const proposal_error = new Error(
                                    `${proposal.contract_type} proposal failed${code ? ` (${code})` : ''}: ${message}`
                                );
                                if (code) proposal_error.code = code;
                                this.$scope?.observer?.emit('Error', proposal_error);
                            }

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
            if (is_higher_lower_pair) return proposals_promise;
        }

        requestPairProposal(proposal) {
            let timeout_id;
            const send_promise = Promise.resolve().then(() => {
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

            return Promise.race([send_promise, timeout_promise]).finally(() => clearTimeout(timeout_id));
        }

        validatePairProposalResponse(response, template) {
            const { contract_type, passthrough } = template;
            const echoed_request = response?.echo_req;
            const echoed_passthrough = getResponsePassthrough(response);
            const current_purchase_reference = this.getPurchaseReference();

            if (response?.msg_type !== 'proposal' || !response?.proposal?.id) {
                throw new Error(`Deriv returned an invalid ${contract_type} proposal response.`);
            }

            if (
                echoed_request?.proposal !== 1 ||
                echoed_request?.contract_type !== contract_type ||
                echoed_passthrough?.contract_type !== contract_type ||
                echoed_passthrough?.purchase_reference !== passthrough?.purchase_reference ||
                echoed_passthrough?.purchase_reference !== current_purchase_reference
            ) {
                throw new Error(
                    `Deriv returned a ${contract_type} proposal that does not match the current purchase reference.`
                );
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
            api_base.subscribeToMessages(response => {
                if (getResponseData(response)?.msg_type === 'proposal') {
                    // Pair proposals are marked ready only after their matching api.send response is validated.
                    this.addProposalResponse(response, !isHigherLowerPair(this.options?.contractTypes));
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
