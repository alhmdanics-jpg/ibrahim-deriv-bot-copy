import { getRoundedNumber } from '@/components/shared';
import { api_base } from '../../api/api-base';
import {
    contract as broadcastContract,
    contractStatus,
    getPairFinalContractDiagnostic,
    pairDiagnostic,
} from '../utils/broadcast';
import { openContractReceived, sell } from './state/actions';

export default Engine =>
    class OpenContract extends Engine {
        observeOpenContract() {
            if (!api_base.api) return;
            api_base.subscribeToMessages(({ data }) => {
                if (data.msg_type === 'proposal_open_contract') {
                    const contract = data.proposal_open_contract;

                    if (!contract || !this.expectedContractId(contract?.contract_id)) {
                        return;
                    }

                    this.setContractFlags(contract);

                    this.data.contract = contract;

                    if (this.isBothPurchase && Array.isArray(this.contractIds) && this.contractIds.length > 0) {
                        this.contractStates[contract.contract_id] = contract;
                        broadcastContract({ accountID: api_base.account_info.loginid, ...contract });
                        this.checkBothContracts();
                        return;
                    }

                    broadcastContract({ accountID: api_base.account_info.loginid, ...contract });

                    if (this.isSold) {
                        this.contractId = '';
                        clearTimeout(this.transaction_recovery_timeout);
                        this.updateTotals(contract);
                        contractStatus({
                            id: 'contract.sold',
                            data: contract.transaction_ids.sell,
                            contract,
                        });

                        if (this.afterPromise) {
                            this.afterPromise();
                        }

                        this.store.dispatch(sell());
                    } else {
                        this.store.dispatch(openContractReceived());
                    }
                }
            });
        }

        waitForAfter() {
            return new Promise(resolve => {
                this.afterPromise = resolve;
            });
        }

        checkBothContracts() {
            if (!this.isBothPurchase || !this.bothPurchasesSettled || !this.contractIds?.length) return;

            const allContractsReceived = this.contractIds.every(id => this.contractStates[id]);
            if (allContractsReceived && !this.bothOpenDispatched) {
                this.bothOpenDispatched = true;
                this.store.dispatch(openContractReceived());
            }

            const allSold = this.contractIds.every(id => this.contractStates[id]?.is_sold);
            if (allSold && !this.bothResultProcessed) {
                this.bothResultProcessed = true;
                this.contractId = '';
                clearTimeout(this.transaction_recovery_timeout);

                const settledContracts = this.contractIds.map(id => this.contractStates[id]);
                this.updateTotalsForContracts(settledContracts);
                settledContracts.forEach(settledContract => {
                    const project_contract_type = Object.keys(this.contractsByType ?? {}).find(
                        type => this.contractsByType[type]?.contract_id === settledContract.contract_id
                    );
                    pairDiagnostic({
                        event: 'contract_final',
                        pair_id: this.pairDiagnosticId,
                        contract_type: project_contract_type || settledContract.contract_type,
                        contract_id: settledContract.contract_id,
                        returned: getPairFinalContractDiagnostic(settledContract),
                    });

                    contractStatus({
                        id: 'contract.sold',
                        data: settledContract.transaction_ids?.sell,
                        contract: settledContract,
                    });
                });

                if (this.afterPromise) this.afterPromise();
                this.store.dispatch(sell());
            }
        }

        setContractFlags(contract) {
            const { is_expired, is_valid_to_sell, is_sold, entry_tick } = contract;

            this.isSold = Boolean(is_sold);
            this.isSellAvailable = !this.isSold && Boolean(is_valid_to_sell);
            this.isExpired = Boolean(is_expired);
            this.hasEntryTick = Boolean(entry_tick);
        }

        expectedContractId(contractId) {
            if (this.isBothPurchase && Array.isArray(this.contractIds) && this.contractIds.length > 0) {
                return this.contractIds.includes(contractId);
            }

            return this.contractId && contractId === this.contractId;
        }
        
        getSellPrice() {
            const { bid_price: bidPrice, buy_price: buyPrice, currency } = this.data.contract;
            return getRoundedNumber(Number(bidPrice) - Number(buyPrice), currency);
        }
    };
