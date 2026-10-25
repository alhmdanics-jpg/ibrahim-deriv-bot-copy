jest.mock('../../../../constants/messages', () => ({ LogTypes: {} }));
jest.mock('../../../api/api-base', () => ({ api_base: { api: { send: jest.fn() } } }));
jest.mock('../../utils/broadcast', () => ({
    contractStatus: jest.fn(),
    getPairBuyRequestDiagnostic: jest.fn(),
    getPairBuyResponseDiagnostic: jest.fn(),
    info: jest.fn(),
    log: jest.fn(),
    pairDiagnostic: jest.fn(),
}));
jest.mock('../../utils/helpers', () => ({
    doUntilDone: jest.fn(),
    getPairTradeOptionsForContract: jest.fn(value => value),
    getUUID: jest.fn(() => 'pair-id'),
    recoverFromError: jest.fn(),
    tradeOptionToBuy: jest.fn((contractType, tradeOptions) => ({
        buy: '1',
        price: tradeOptions.amount,
        parameters: { contract_type: contractType },
    })),
}));
jest.mock('../../utils/pair-payout-validation', () => ({
    ...jest.requireActual('../../utils/pair-payout-validation'),
    withValidatedPairProposals: jest.fn(
        jest.requireActual('../../utils/pair-payout-validation').withValidatedPairProposals
    ),
}));
jest.mock('../state/actions', () => ({ purchaseSuccessful: jest.fn() }));
jest.mock('../state/constants', () => ({ BEFORE_PURCHASE: 'BEFORE_PURCHASE' }));

import Purchase from '../Purchase';
import { api_base } from '../../../api/api-base';
import { doUntilDone, tradeOptionToBuy } from '../../utils/helpers';

const createEngine = isProposalRequired => {
    const PurchaseEngine = Purchase(
        class {
            constructor() {
                this.store = { getState: () => ({ scope: 'BEFORE_PURCHASE' }), dispatch: jest.fn() };
            }
        }
    );
    const engine = new PurchaseEngine();
    engine.options = { contractTypes: ['HIGHER', 'LOWER'] };
    engine.tradeOptions = { amount: 1, currency: 'USD' };
    engine.is_proposal_subscription_required = isProposalRequired;
    engine.data = { proposals: [] };
    engine.getPurchaseReference = () => 'current-reference';
    engine.$scope = { observer: { emit: jest.fn() } };
    return engine;
};

describe('Higher/Lower pair purchase preflight', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        doUntilDone.mockReset();
        api_base.api.send.mockReset();
    });

    it('does not fall back to direct buys when pair proposals are disabled', async () => {
        const engine = createEngine(false);

        await expect(engine.purchase('both')).rejects.toThrow('current HIGHER and LOWER quotes are required');
        expect(api_base.api.send).not.toHaveBeenCalled();
    });

    it('does not buy when current-reference pair proposals are missing', async () => {
        const engine = createEngine(true);

        await expect(engine.purchase('both')).rejects.toThrow('current HIGHER quote is unavailable');
        expect(api_base.api.send).not.toHaveBeenCalled();
        expect(doUntilDone).not.toHaveBeenCalled();
    });

    it('rejects a below-minimum current quote before starting either buy action', async () => {
        const engine = createEngine(true);
        engine.data.proposals = [
            {
                id: 'higher-id',
                ask_price: '1',
                contract_type: 'HIGHER',
                payout: 8,
                purchase_reference: 'current-reference',
            },
            {
                id: 'lower-id',
                ask_price: '1',
                contract_type: 'LOWER',
                payout: 7.99,
                purchase_reference: 'current-reference',
            },
        ];

        await expect(engine.purchase('both')).rejects.toThrow('LOWER payout 7.99 USD is below the required 8 USD');
        expect(doUntilDone).not.toHaveBeenCalled();
        expect(api_base.api.send).not.toHaveBeenCalled();
    });

    it('renews pair proposals only after both current proposal-based buys settle', async () => {
        const engine = createEngine(true);
        const resolveBuy = {};
        const completedBuys = [];
        engine.data.proposals = [
            {
                id: 'higher-id',
                ask_price: '1',
                contract_type: 'HIGHER',
                payout: 8,
                purchase_reference: 'current-reference',
            },
            {
                id: 'lower-id',
                ask_price: '1',
                contract_type: 'LOWER',
                payout: 8,
                purchase_reference: 'current-reference',
            },
        ];
        doUntilDone.mockImplementation(action => action());
        api_base.api.send.mockImplementation(
            ({ buy }) =>
                new Promise(resolve => {
                    resolveBuy[buy] = response => {
                        completedBuys.push(buy);
                        resolve(response);
                    };
                })
        );
        engine.updateAndReturnTotalRuns = jest.fn();
        engine.checkBothContracts = jest.fn();
        let renewedAfter;
        engine.renewProposalsOnPurchase = jest.fn(() => {
            renewedAfter = [...completedBuys];
        });

        const purchase = engine.purchase('both');

        expect(api_base.api.send).toHaveBeenCalledTimes(2);
        expect(engine.renewProposalsOnPurchase).not.toHaveBeenCalled();

        resolveBuy['higher-id']({
            buy: { contract_id: 'higher-contract', transaction_id: 'higher-transaction', longcode: 'higher' },
        });
        expect(engine.renewProposalsOnPurchase).not.toHaveBeenCalled();

        resolveBuy['lower-id']({
            buy: { contract_id: 'lower-contract', transaction_id: 'lower-transaction', longcode: 'lower' },
        });
        await purchase;

        expect(engine.renewProposalsOnPurchase).toHaveBeenCalledTimes(1);
        expect(renewedAfter).toEqual(['higher-id', 'lower-id']);
    });

    it('keeps direct purchase behavior for a different two-contract pair', async () => {
        const engine = createEngine(false);
        engine.options.contractTypes = ['CALL', 'PUT'];
        api_base.api.send.mockImplementation(request =>
            Promise.resolve({
                buy: {
                    contract_id: `contract-${api_base.api.send.mock.calls.length}`,
                    transaction_id: `transaction-${api_base.api.send.mock.calls.length}`,
                    longcode: request?.parameters?.contract_type || 'contract',
                },
            })
        );
        doUntilDone.mockImplementation(action => action());
        engine.updateAndReturnTotalRuns = jest.fn();
        engine.checkBothContracts = jest.fn();
        engine.renewProposalsOnPurchase = jest.fn();

        await engine.purchase('both');

        expect(api_base.api.send).toHaveBeenCalledTimes(2);
        expect(doUntilDone).toHaveBeenCalledTimes(2);
        expect(tradeOptionToBuy).toHaveBeenNthCalledWith(1, 'CALL', engine.tradeOptions);
        expect(tradeOptionToBuy).toHaveBeenNthCalledWith(2, 'PUT', engine.tradeOptions);
        expect(api_base.api.send.mock.calls.map(([request]) => request.parameters.contract_type)).toEqual([
            'CALL',
            'PUT',
        ]);
        expect(engine.renewProposalsOnPurchase).not.toHaveBeenCalled();
    });
});
