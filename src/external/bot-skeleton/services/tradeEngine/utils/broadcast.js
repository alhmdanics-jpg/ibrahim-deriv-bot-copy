import { config } from '../../../constants/config';
import { observer as globalObserver } from '../../../utils/observer';

export const contract = c => globalObserver.emit('bot.contract', c);

export const contractStatus = c => globalObserver.emit('contract.status', c);

export const info = i => globalObserver.emit('bot.info', i);

export const notify = (className, message) =>
    globalObserver.emit('ui.log.notify', { className, message, sound: config().lists.NOTIFICATION_SOUND[0][1] });

export const log = (log_type, extra) => globalObserver.emit('ui.log.success', { log_type, extra });

export const error = message => globalObserver.emit('ui.log.error', message);

const pickDefinedFields = (source, fields) =>
    fields.reduce((result, field) => {
        if (source && Object.prototype.hasOwnProperty.call(source, field) && source[field] !== undefined) {
            result[field] = source[field];
        }
        return result;
    }, {});

export const getPairBuyRequestDiagnostic = request => ({
    ...pickDefinedFields(request?.parameters, [
        'underlying_symbol',
        'contract_type',
        'barrier',
        'amount',
        'basis',
        'duration',
        'duration_unit',
    ]),
    ...pickDefinedFields(request, ['price']),
});

export const getPairBuyResponseDiagnostic = buy =>
    pickDefinedFields(buy, ['contract_id', 'buy_price', 'payout', 'transaction_id', 'purchase_time']);

export const getPairFinalContractDiagnostic = contract =>
    pickDefinedFields(contract, [
        'contract_id',
        'contract_type',
        'status',
        'entry_spot',
        'exit_spot',
        'buy_price',
        'payout',
        'profit',
        'sell_price',
    ]);

export const pairDiagnostic = entry =>
    globalObserver.emit('ui.log.diagnostic', `[PAIR_DIAGNOSTIC] ${JSON.stringify(entry)}`);
