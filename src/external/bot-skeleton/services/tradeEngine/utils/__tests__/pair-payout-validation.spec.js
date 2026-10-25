import {
    getMinimumPairPayout,
    isHigherLowerPair,
    requiresProposalForTrade,
    withValidatedPairProposals,
} from '../pair-payout-validation';

const makeProposals = (higherPayout, lowerPayout, purchaseReference = 'current-reference') => [
    {
        id: 'higher-proposal',
        ask_price: '1',
        contract_type: 'HIGHER',
        payout: higherPayout,
        purchase_reference: purchaseReference,
    },
    {
        id: 'lower-proposal',
        ask_price: '1',
        contract_type: 'LOWER',
        payout: lowerPayout,
        purchase_reference: purchaseReference,
    },
];

const options = (proposals, stake) => ({
    proposals,
    purchaseReference: 'current-reference',
    stake,
    currency: 'USD',
});

describe('Higher/Lower pair minimum payout acceptance', () => {
    it('requests proposals for Higher/Lower only, without changing individual or other pair decisions', () => {
        expect(requiresProposalForTrade(['HIGHER', 'LOWER'], false, false)).toBe(true);
        expect(requiresProposalForTrade(['CALL'], false, false)).toBe(false);
        expect(requiresProposalForTrade(['CALL', 'PUT'], false, false)).toBe(false);
        expect(requiresProposalForTrade(['CALL'], true, false)).toBe(true);
        expect(isHigherLowerPair(['LOWER', 'HIGHER'])).toBe(true);
        expect(isHigherLowerPair(['HIGHER', 'HIGHER'])).toBe(false);
    });

    it('accepts both payouts at 8x a stake of 1', () => {
        const startPairPurchase = jest.fn(pair => pair);

        const result = withValidatedPairProposals(options(makeProposals(8, '8'), 1), startPairPurchase);

        expect(result.HIGHER.payout).toBe(8);
        expect(result.LOWER.payout).toBe('8');
        expect(startPairPurchase).toHaveBeenCalledTimes(1);
    });

    it('rejects the pair at a 7.99 payout and never starts a purchase', () => {
        const buy = jest.fn();
        const startPairPurchase = jest.fn(() => buy());

        expect(() => withValidatedPairProposals(options(makeProposals(8, 7.99), 1), startPairPurchase)).toThrow(
            'LOWER payout 7.99 USD is below the required 8 USD'
        );
        expect(startPairPurchase).not.toHaveBeenCalled();
        expect(buy).not.toHaveBeenCalled();
    });

    it('accepts both payouts at 8x a stake of 0.50', () => {
        const startPairPurchase = jest.fn(pair => pair);

        const result = withValidatedPairProposals(options(makeProposals(4, 4), 0.5), startPairPurchase);

        expect(result.HIGHER.payout).toBe(4);
        expect(result.LOWER.payout).toBe(4);
        expect(startPairPurchase).toHaveBeenCalledTimes(1);
    });

    it('compares decimal values exactly at the threshold', () => {
        expect(getMinimumPairPayout(0.35)).toBe('2.8');
        expect(withValidatedPairProposals(options(makeProposals('2.8', '2.80'), 0.35), pair => pair)).toBeTruthy();
        expect(() =>
            withValidatedPairProposals(options(makeProposals('8', '7.9999999999999999'), 1), pair => pair)
        ).toThrow('LOWER payout 7.9999999999999999 USD is below the required 8 USD');
        expect(withValidatedPairProposals(options(makeProposals('8', '8'), 1), pair => pair).LOWER.payout).toBe('8');
    });

    it('reports the original payout text rather than a rounded numeric representation', () => {
        const payout = '7.9999999999999999';

        expect(() => withValidatedPairProposals(options(makeProposals('8', payout), 1), pair => pair)).toThrow(
            `LOWER payout ${payout} USD is below the required 8 USD`
        );
    });

    it.each([
        ['missing payout', makeProposals(8, undefined)],
        ['invalid payout', makeProposals(8, 'not-a-number')],
    ])('rejects a %s and makes zero purchase calls', (_caseName, proposals) => {
        const buy = jest.fn();
        const startPairPurchase = jest.fn(() => buy());

        expect(() => withValidatedPairProposals(options(proposals, 1), startPairPurchase)).toThrow(
            'LOWER quote has no valid payout'
        );
        expect(startPairPurchase).not.toHaveBeenCalled();
        expect(buy).not.toHaveBeenCalled();
    });

    it('rejects an API-invalid quote and includes the required payout', () => {
        const proposals = makeProposals(8, 8);
        proposals[1].error = { error: { message: 'Invalid contract proposal' } };
        const startPairPurchase = jest.fn();

        expect(() => withValidatedPairProposals(options(proposals, 1), startPairPurchase)).toThrow(
            'LOWER quote is invalid (Invalid contract proposal). Required payout per contract: 8 USD.'
        );
        expect(startPairPurchase).not.toHaveBeenCalled();
    });

    it('rejects a quote without a usable proposal id or ask price', () => {
        const proposals = makeProposals(8, 8);
        proposals[1].ask_price = undefined;
        const startPairPurchase = jest.fn();

        expect(() => withValidatedPairProposals(options(proposals, 1), startPairPurchase)).toThrow(
            'LOWER quote is missing a valid proposal id or ask price. Required payout per contract: 8 USD.'
        );
        expect(startPairPurchase).not.toHaveBeenCalled();
    });

    it('rejects quotes from a previous purchase reference', () => {
        const staleProposals = makeProposals(20, 20, 'old-reference');
        const startPairPurchase = jest.fn();

        expect(() => withValidatedPairProposals(options(staleProposals, 1), startPairPurchase)).toThrow(
            'current HIGHER quote is unavailable'
        );
        expect(startPairPurchase).not.toHaveBeenCalled();
    });
});
