import type { TFormData } from '@/pages/bot-builder/quick-strategy/types';

export const getSavedQuickStrategyValues = (storage: Pick<Storage, 'getItem'> = localStorage): TFormData => {
    try {
        const saved_values = JSON.parse(storage.getItem('qs-fields') ?? '{}');
        return saved_values && typeof saved_values === 'object' && !Array.isArray(saved_values)
            ? (saved_values as TFormData)
            : {};
    } catch {
        return {};
    }
};

export const saveQuickStrategyValues = (data: TFormData, storage: Pick<Storage, 'setItem'> = localStorage) => {
    storage.setItem('qs-fields', JSON.stringify(data));
};

export const getEffectiveQuickStrategyData = (selected_strategy: string, data: TFormData) =>
    selected_strategy === 'VIDEO_PAIR' ? { ...data, tradetype: 'higherlower', type: 'both' } : data;

export const splitSignedBarrierOffset = (value: string | number) => {
    const numeric_value = Number(value);

    return {
        magnitude: Math.abs(numeric_value),
        sign: numeric_value < 0 ? '-' : '+',
    };
};
