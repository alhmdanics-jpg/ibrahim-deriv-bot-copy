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

import {
    formatBarrierOffset,
    getPairTradeOptionsForContract,
    getRequestErrorDetails,
    tradeOptionToBuy,
    tradeOptionToProposal,
} from '../helpers';

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

describe('proposal request error details', () => {
    it('identifies the request and preserves the server error code and message', () => {
        expect(
            getRequestErrorDetails({
                error: { code: 'InvalidContractProposal', message: 'Barrier is invalid' },
                echo_req: { proposal: 1, req_id: 42 },
            })
        ).toEqual({
            message_type: 'proposal',
            code: 'InvalidContractProposal',
            safe_code: 'InvalidContractProposal',
            message: 'Barrier is invalid',
            request_id: '42',
        });
    });

    it('redacts credential values and does not expose request payload fields', () => {
        const details = getRequestErrorDetails({
            error: {
                code: 'RequestFailed',
                message: 'Invalid token=secret-value Bearer bearer-value',
            },
            echo_req: {
                proposal: 1,
                token: 'request-secret',
            },
        });

        expect(details).toEqual({
            message_type: 'proposal',
            code: 'RequestFailed',
            safe_code: 'RequestFailed',
            message: 'Invalid token=[redacted] Bearer [redacted]',
            request_id: '',
        });
        expect(JSON.stringify(details)).not.toContain('request-secret');
    });

    it('uses unknown only when neither the response nor echo request identifies a known type', () => {
        expect(getRequestErrorDetails({ error: { code: 'RequestFailed', message: 'Failed' } })).toMatchObject({
            message_type: 'unknown',
            code: 'RequestFailed',
            message: 'Failed',
        });
    });
});
