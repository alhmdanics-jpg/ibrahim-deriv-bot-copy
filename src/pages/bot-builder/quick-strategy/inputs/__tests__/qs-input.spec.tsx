import React from 'react';
import { Formik, useFormikContext } from 'formik';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TFormData } from '../../types';
import QSInput from '../qs-input';

jest.mock('@/hooks/useStore', () => ({
    useStore: () => ({
        client: { currency: 'USD' },
        quick_strategy: { additional_data: {}, loss_threshold_warning_data: { highlight_field: [] } },
    }),
}));

jest.mock('@/components/shared_ui/popover', () => ({
    __esModule: true,
    default: ({ children }: { children: React.ReactNode }) => children,
}));

type TOffsetFieldProps = {
    name: string;
    onValueChange: jest.Mock;
};

const OffsetField = ({ name, onValueChange }: TOffsetFieldProps) => {
    const { setFieldValue } = useFormikContext<TFormData>();

    return (
        <QSInput
            name={name}
            type='number'
            min={-999999999999}
            onChange={(field_name, value) => {
                onValueChange(field_name, value);
                void setFieldValue(field_name, value);
            }}
        />
    );
};

const renderOffsetField = (name = 'higher_barrier_offset') => {
    const onValueChange = jest.fn();
    render(
        <Formik initialValues={{ [name]: '1' }} onSubmit={jest.fn()}>
            <OffsetField name={name} onValueChange={onValueChange} />
        </Formik>
    );

    return { input: screen.getByTestId('qs-input') as HTMLInputElement, onValueChange };
};

describe('Quick Strategy numeric offset input', () => {
    it.each([
        ['0.35', 0.35],
        ['0.5', 0.5],
        ['1', 1],
        ['1.25', 1.25],
        ['0.357', 0.357],
    ] as const)('preserves the entered value %s', (entered_value, expected_value) => {
        const { input, onValueChange } = renderOffsetField();

        fireEvent.change(input, { target: { value: String(entered_value) } });

        expect(input).toHaveValue(expected_value);
        expect(onValueChange).toHaveBeenLastCalledWith('higher_barrier_offset', expected_value);
    });

    it.each([
        ['higher_barrier_offset', '-0.35', -0.35],
        ['lower_barrier_offset', '-1.25', -1.25],
    ] as const)('preserves an allowed negative value for %s', (name, entered_value, expected_value) => {
        const { input, onValueChange } = renderOffsetField(name);

        fireEvent.change(input, { target: { value: String(entered_value) } });

        expect(input).toHaveValue(expected_value);
        expect(onValueChange).toHaveBeenLastCalledWith(name, expected_value);
    });

    it('keeps an empty value empty and allows entering a decimal again', () => {
        const { input, onValueChange } = renderOffsetField();

        fireEvent.change(input, { target: { value: '' } });
        expect(input.value).toBe('');
        expect(onValueChange).toHaveBeenLastCalledWith('higher_barrier_offset', '');

        fireEvent.change(input, { target: { value: '0.35' } });

        expect(input).toHaveValue(0.35);
        expect(onValueChange).toHaveBeenLastCalledWith('higher_barrier_offset', 0.35);
    });
});
