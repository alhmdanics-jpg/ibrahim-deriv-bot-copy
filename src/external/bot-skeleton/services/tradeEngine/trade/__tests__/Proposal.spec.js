jest.mock('../../../api/api-base', () => ({ api_base: {} }));
jest.mock('../../utils/helpers', () => ({ doUntilDone: jest.fn(), tradeOptionToProposal: jest.fn() }));
jest.mock('../state/actions', () => ({
    clearProposals: jest.fn(),
    proposalsReady: jest.fn(() => ({ type: 'PROPOSALS_READY' })),
}));
jest.mock('@deriv-com/translations', () => ({ localize: value => value }));

import Proposal from '../Proposal';
import { proposalsReady } from '../state/actions';

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
});
