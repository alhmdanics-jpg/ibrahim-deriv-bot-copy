import {
    getEffectiveQuickStrategyData,
    getSavedQuickStrategyValues,
    saveQuickStrategyValues,
    splitSignedBarrierOffset,
} from '../quick-strategy-utils';

describe('Quick Strategy saved values', () => {
    beforeEach(() => localStorage.clear());

    it('restores the selected market, stake, duration, unit, and signed offsets', () => {
        const selected_values = {
            symbol: 'R_100',
            stake: '2.5',
            durationtype: 't',
            duration: '5',
            higher_barrier_offset: 0.35,
            lower_barrier_offset: -0.5,
        };

        saveQuickStrategyValues(selected_values);

        expect(getSavedQuickStrategyValues()).toEqual(selected_values);
        expect(getEffectiveQuickStrategyData('VIDEO_PAIR', getSavedQuickStrategyValues())).toEqual({
            ...selected_values,
            tradetype: 'higherlower',
            type: 'both',
        });
    });
});

describe('getEffectiveQuickStrategyData', () => {
    it('keeps the selected VIDEO_PAIR market, stake, duration, and offsets', () => {
        const selected_values = {
            symbol: 'R_100',
            tradetype: 'callput',
            type: 'single',
            durationtype: 't',
            duration: '3',
            stake: '2.5',
            higher_barrier_offset: '0.35',
            lower_barrier_offset: '-0.42',
        };

        expect(getEffectiveQuickStrategyData('VIDEO_PAIR', selected_values)).toEqual({
            ...selected_values,
            tradetype: 'higherlower',
            type: 'both',
        });
    });

    it('does not change another quick strategy form', () => {
        const selected_values = { symbol: 'R_100', stake: '2.5', duration: '3' };

        expect(getEffectiveQuickStrategyData('MARTINGALE', selected_values)).toBe(selected_values);
    });

    it('retains the sign separately from an offset magnitude for the block fields', () => {
        expect(splitSignedBarrierOffset(0.35)).toEqual({ magnitude: 0.35, sign: '+' });
        expect(splitSignedBarrierOffset(-0.35)).toEqual({ magnitude: 0.35, sign: '-' });
    });
});
