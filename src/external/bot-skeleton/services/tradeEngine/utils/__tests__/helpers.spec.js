jest.mock('@/components/shared', () => ({
    findValueByKeyRecursively: jest.fn(),
    formatTime: jest.fn(),
    getRoundedNumber: jest.fn(),
    isEmptyObject: value => value == null || Object.keys(value).length === 0,
}));
jest.mock('@/external/bot-skeleton/constants', () => ({ config: jest.fn(() => ({})) }));
jest.mock('@deriv-com/translations', () => ({ localize: value => value }));
jest.mock('@/external/bot-skeleton/utils/observer', () => ({ observer: { emit: jest.fn() } }));
jest.mock('../broadcast', () => ({ error: jest.fn() }));

import { formatBarrierOffset, getPairTradeOptionsForContract, tradeOptionToBuy, tradeOptionToProposal } from '../helpers';

describe('Higher/Lower pair barrier request mapping', () => {
    const trade_options = {
        amount: 5,
        basis: 'stake',
        barrierOffset: '+0.35',
        secondBarrierOffset: '-0.35',
        contractTypes: ['HIGHER', 'LOWER'],
        currency: 'USD',
        duration: 5,
        duration_unit: 't',
        symbol: 'R_100',
    };

    it('preserves scale and sign while limiting barriers to two decimal places', () => {
        expect(formatBarrierOffset('+0.35')).toBe('+0.35');
        expect(formatBarrierOffset('-0.35')).toBe('-0.35');
        expect(formatBarrierOffset('+0.357')).toBe('+0.36');
        expect(formatBarrierOffset('-0.357')).toBe('-0.36');
    });

    it('passes the selected market, stake basis, duration, and each signed offset to the direct buy request', () => {
        const higher_options = getPairTradeOptionsForContract(trade_options, 'HIGHER');
        const lower_options = getPairTradeOptionsForContract(trade_options, 'LOWER');
        const higher_buy = tradeOptionToBuy('HIGHER', higher_options);
        const lower_buy = tradeOptionToBuy('LOWER', lower_options);

        expect(higher_buy).toMatchObject({
            buy: '1',
            price: 5,
            parameters: {
                amount: 5,
                basis: 'stake',
                contract_type: 'HIGHER',
                duration: 5,
                duration_unit: 't',
                underlying_symbol: 'R_100',
                barrier: '+0.35',
            },
        });
        expect(higher_buy.parameters).not.toHaveProperty('barrier2');
        expect(lower_buy).toMatchObject({
            price: 5,
            parameters: {
                amount: 5,
                basis: 'stake',
                contract_type: 'LOWER',
                duration: 5,
                duration_unit: 't',
                underlying_symbol: 'R_100',
                barrier: '-0.35',
            },
        });
        expect(lower_buy.parameters).not.toHaveProperty('barrier2');
        expect(trade_options.barrierOffset).toBe('+0.35');
        expect(trade_options.secondBarrierOffset).toBe('-0.35');
    });

    it('uses the same unscaled pair barriers when building proposal requests', () => {
        expect(tradeOptionToProposal(trade_options, 'reference')).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ contract_type: 'HIGHER', barrier: '+0.35' }),
                expect.objectContaining({ contract_type: 'LOWER', barrier: '-0.35' }),
            ])
        );
    });
});
