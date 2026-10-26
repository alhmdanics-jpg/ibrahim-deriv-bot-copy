jest.mock('../../../api/api-base', () => ({
    api_base: {
        api: { send: jest.fn() },
        subscribeToMessages: jest.fn(),
    },
}));
jest.mock('../../utils/helpers', () => ({ doUntilDone: jest.fn(), tradeOptionToProposal: jest.fn() }));
jest.mock('../state/actions', () => ({
    clearProposals: jest.fn(),
    proposalsReady: jest.fn(() => ({ type: 'PROPOSALS_READY' })),
}));
jest.mock('@deriv-com/translations', () => ({ localize: value => value }));

import Proposal from '../Proposal';
import { api_base } from '../../../api/api-base';
import { proposalsReady } from '../state/actions';
import { doUntilDone } from '../../utils/helpers';

const createPairEngine = () => {
    const ProposalEngine = Proposal(class {});
    const engine = new ProposalEngine();
    engine.data = { proposals: [] };
    engine.options = { contractTypes: ['HIGHER', 'LOWER'] };
    engine.proposal_templates = ['HIGHER', 'LOWER'].map(contract_type => ({
        amount: 1,
        basis: 'stake',
        contract_type,
        currency: 'USD',
        duration: 5,
        duration_unit: 't',
        passthrough: { contract_type, purchase_reference: 'current-reference' },
        proposal: 1,
        underlying_symbol: 'R_100',
    }));
    engine.startPromise = Promise.resolve();
    engine.store = { dispatch: jest.fn() };
    engine.$scope = { observer: { emit: jest.fn() } };
    engine.getPurchaseReference = () => 'current-reference';
    return engine;
};

const makeProposalResponse = request => ({
    echo_req: {
        ...request,
        req_id: request.contract_type === 'HIGHER' ? 11 : 12,
    },
    msg_type: 'proposal',
    proposal: {
        id: `${request.contract_type.toLowerCase()}-proposal-id`,
        ask_price: 1,
        payout: 8,
    },
});

beforeEach(() => {
    api_base.api.send.mockReset();
    doUntilDone.mockReset();
});

afterEach(() => {
    jest.useRealTimers();
});

describe('Higher/Lower pair proposal readiness', () => {
    it('waits until both current-reference quotes have arrived before marking proposals ready', async () => {
        const ProposalEngine = Proposal(class {});
        const engine = new ProposalEngine();
        engine.data = {
            proposals: [{ contract_type: 'HIGHER', purchase_reference: 'current-reference', id: 'higher-id', payout: 8 }],
        };
        engine.proposal_templates = [
            { contract_type: 'HIGHER', passthrough: { purchase_reference: 'current-reference' } },
            { contract_type: 'LOWER', passthrough: { purchase_reference: 'current-reference' } },
        ];
        engine.startPromise = Promise.resolve();
        engine.store = { dispatch: jest.fn() };

        engine.checkProposalReady();
        await Promise.resolve();
        expect(engine.store.dispatch).not.toHaveBeenCalled();

        engine.data.proposals.push({
            contract_type: 'LOWER',
            purchase_reference: 'current-reference',
            id: 'lower-id',
            payout: 8,
        });
        engine.checkProposalReady();
        await Promise.resolve();

        expect(engine.store.dispatch).toHaveBeenCalledTimes(1);
        expect(engine.store.dispatch).toHaveBeenCalledWith(proposalsReady());
    });

    it('does not count a quote from a stale purchase reference', () => {
        const ProposalEngine = Proposal(class {});
        const engine = new ProposalEngine();
        engine.data = {
            proposals: [
                { contract_type: 'HIGHER', purchase_reference: 'stale-reference', id: 'stale-higher' },
                { contract_type: 'LOWER', purchase_reference: 'current-reference', id: 'current-lower' },
            ],
        };
        engine.proposal_templates = [
            { contract_type: 'HIGHER', passthrough: { purchase_reference: 'current-reference' } },
            { contract_type: 'LOWER', passthrough: { purchase_reference: 'current-reference' } },
        ];
        engine.startPromise = Promise.resolve();
        engine.store = { dispatch: jest.fn() };

        engine.checkProposalReady();

        expect(engine.store.dispatch).not.toHaveBeenCalled();
    });

    it('reads passthrough from echo_req and marks both current quotes ready', async () => {
        const engine = createPairEngine();
        api_base.api.send.mockImplementation(request => {
            const response = makeProposalResponse(request);
            return Promise.resolve(request.contract_type === 'HIGHER' ? { data: response } : response);
        });

        await engine.requestProposals();
        await Promise.resolve();

        expect(engine.data.proposals).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ contract_type: 'HIGHER', purchase_reference: 'current-reference' }),
                expect.objectContaining({ contract_type: 'LOWER', purchase_reference: 'current-reference' }),
            ])
        );
        expect(engine.store.dispatch).toHaveBeenCalledTimes(1);
        expect(engine.store.dispatch).toHaveBeenCalledWith(proposalsReady());
    });

    it('reports a resolved API error and does not mark the pair ready', async () => {
        const engine = createPairEngine();
        api_base.api.send.mockImplementation(request => {
            if (request.contract_type === 'HIGHER') {
                return Promise.resolve({
                    error: { code: 'BarrierValidationError', message: 'Barrier was rejected' },
                    echo_req: request,
                    msg_type: 'proposal',
                });
            }
            return Promise.resolve(makeProposalResponse(request));
        });

        await engine.requestProposals();
        await Promise.resolve();

        expect(engine.$scope.observer.emit).toHaveBeenCalledTimes(1);
        expect(engine.$scope.observer.emit.mock.calls[0][1].message).toContain('BarrierValidationError');
        expect(engine.$scope.observer.emit.mock.calls[0][1].message).toContain('Barrier was rejected');
        expect(engine.store.dispatch).not.toHaveBeenCalledWith(proposalsReady());
    });

    it('reports a rejected API request and does not mark the pair ready', async () => {
        const engine = createPairEngine();
        api_base.api.send.mockImplementation(request => {
            if (request.contract_type === 'LOWER') {
                return Promise.reject({
                    error: { code: 'GetProposalFailure', message: 'Lower quote failed' },
                    echo_req: request,
                    msg_type: 'proposal',
                });
            }
            return Promise.resolve(makeProposalResponse(request));
        });

        await engine.requestProposals();
        await Promise.resolve();

        expect(engine.$scope.observer.emit).toHaveBeenCalledTimes(1);
        expect(engine.$scope.observer.emit.mock.calls[0][1].message).toContain('GetProposalFailure');
        expect(engine.$scope.observer.emit.mock.calls[0][1].message).toContain('Lower quote failed');
        expect(engine.store.dispatch).not.toHaveBeenCalledWith(proposalsReady());
    });

    it('rejects a proposal response tied to a different purchase reference', async () => {
        const engine = createPairEngine();
        api_base.api.send.mockImplementation(request => {
            const response = makeProposalResponse(request);
            if (request.contract_type === 'LOWER') {
                response.echo_req.passthrough.purchase_reference = 'stale-reference';
            }
            return Promise.resolve(response);
        });

        await engine.requestProposals();
        await Promise.resolve();

        expect(engine.$scope.observer.emit).toHaveBeenCalledTimes(1);
        expect(engine.$scope.observer.emit.mock.calls[0][1].message).toContain(
            'does not match the current purchase reference'
        );
        expect(engine.store.dispatch).not.toHaveBeenCalledWith(proposalsReady());
    });

    it('stops waiting when a pair proposal response never arrives', async () => {
        jest.useFakeTimers();
        const engine = createPairEngine();
        api_base.api.send.mockImplementation(() => new Promise(() => {}));

        const request_promise = engine.requestProposals();
        await Promise.resolve();
        jest.advanceTimersByTime(15000);
        await request_promise;

        expect(engine.$scope.observer.emit).toHaveBeenCalledTimes(1);
        expect(engine.$scope.observer.emit.mock.calls[0][1].message).toContain('Timed out waiting');
        expect(engine.store.dispatch).not.toHaveBeenCalledWith(proposalsReady());
    });

    it('keeps individual contract proposal requests on the existing retry path', async () => {
        const ProposalEngine = Proposal(class {});
        const engine = new ProposalEngine();
        engine.options = { contractTypes: ['CALL'] };
        engine.proposal_templates = [{ contract_type: 'CALL' }];
        doUntilDone.mockResolvedValue({ msg_type: 'proposal' });

        await engine.requestProposals();

        expect(doUntilDone).toHaveBeenCalledTimes(1);
        expect(api_base.api.send).not.toHaveBeenCalled();
    });
});
