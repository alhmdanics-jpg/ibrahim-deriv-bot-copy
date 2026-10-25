import { findValueByKeyRecursively, formatTime, getRoundedNumber, isEmptyObject } from '@/components/shared';
import { config } from '@/external/bot-skeleton/constants';
import { localize } from '@deriv-com/translations';
import { observer as globalObserver } from '../../../utils/observer';
import { error as logError } from './broadcast';

export const formatBarrierOffset = value => {
    if (typeof value !== 'string') return value;
    const match = value.match(/^([+-]?)(\d+(?:\.\d+)?)$/);
    if (!match || (match[2].split('.')[1]?.length ?? 0) <= 2) return value;

    return `${match[1]}${Number(match[2]).toFixed(2)}`;
};

export const getPairTradeOptionsForContract = (trade_option, contract_type) => {
    const contract_trade_option = { ...trade_option };

    if (contract_type === 'HIGHER') {
        contract_trade_option.barrierOffset = formatBarrierOffset(trade_option.barrierOffset);
        contract_trade_option.secondBarrierOffset = undefined;
    } else if (contract_type === 'LOWER') {
        contract_trade_option.barrierOffset = formatBarrierOffset(trade_option.secondBarrierOffset);
        contract_trade_option.secondBarrierOffset = undefined;
    }

    return contract_trade_option;
};

export const tradeOptionToProposal = (trade_option, purchase_reference) =>
    trade_option.contractTypes.map(type => {
        const is_both_higher_lower =
            trade_option.contractTypes.includes('HIGHER') && trade_option.contractTypes.includes('LOWER');
        const contract_trade_option = is_both_higher_lower
            ? getPairTradeOptionsForContract(trade_option, type)
            : { ...trade_option };

        const proposal = {
            amount: contract_trade_option.amount,
            basis: contract_trade_option.basis,
            contract_type: type,
            currency: contract_trade_option.currency,
            duration: contract_trade_option.duration,
            duration_unit: contract_trade_option.duration_unit,
            multiplier: contract_trade_option.multiplier,
            passthrough: {
                contract_type: type,
                purchase_reference,
            },
            proposal: 1,
            underlying_symbol: contract_trade_option.symbol,
        };
        if (contract_trade_option.prediction !== undefined) {
            proposal.selected_tick = contract_trade_option.prediction;
        }
        if (!['TICKLOW', 'TICKHIGH'].includes(type) && contract_trade_option.prediction !== undefined) {
            proposal.barrier = contract_trade_option.prediction;
        } else if (contract_trade_option.barrierOffset !== undefined) {
            proposal.barrier = contract_trade_option.barrierOffset;
        }
        if (contract_trade_option.secondBarrierOffset !== undefined) {
            proposal.barrier2 = contract_trade_option.secondBarrierOffset;
        }
        if (['MULTUP', 'MULTDOWN'].includes(type)) {
            proposal.duration = undefined;
            proposal.duration_unit = undefined;
        }
        if (!isEmptyObject(contract_trade_option.limit_order)) {
            proposal.limit_order = contract_trade_option.limit_order;
        }
        return proposal;
    });

export const tradeOptionToBuy = (contract_type, trade_option) => {
    const buy = {
        buy: '1',
        price: trade_option.amount,
        parameters: {
            amount: trade_option.amount,
            basis: trade_option.basis,
            contract_type,
            currency: trade_option.currency,
            duration: trade_option.duration,
            duration_unit: trade_option.duration_unit,
            multiplier: trade_option.multiplier,
            underlying_symbol: trade_option.symbol,
        },
    };
    if (trade_option.prediction !== undefined) {
        buy.parameters.selected_tick = trade_option.prediction;
    }
    if (!['TICKLOW', 'TICKHIGH'].includes(contract_type) && trade_option.prediction !== undefined) {
        buy.parameters.barrier = trade_option.prediction;
    } else if (trade_option.barrierOffset !== undefined) {
        buy.parameters.barrier = trade_option.barrierOffset;
    }
    if (trade_option.secondBarrierOffset !== undefined) {
        buy.parameters.barrier2 = trade_option.secondBarrierOffset;
    }
    if (!isEmptyObject(trade_option.app_markup_percentage)) {
        buy.parameters.app_markup_percentage = trade_option.app_markup_percentage;
    }
    if (!isEmptyObject(trade_option.barrier_range)) {
        buy.parameters.barrier_range = trade_option.barrier_range;
    }
    if (!isEmptyObject(trade_option.date_expiry)) {
        buy.parameters.date_expiry = trade_option.date_expiry;
    }
    if (!isEmptyObject(trade_option.date_start)) {
        buy.parameters.date_start = trade_option.date_start;
    }
    if (!isEmptyObject(trade_option.product_type)) {
        buy.parameters.product_type = trade_option.product_type;
    }
    if (!isEmptyObject(trade_option.trading_period_start)) {
        buy.parameters.trading_period_start = trade_option.trading_period_start;
    }
    // This will be required only in the case of multiplier & accumulator contracts
    if (!isEmptyObject(trade_option.limit_order)) {
        buy.parameters.limit_order = trade_option.limit_order;
    }
    // This will be required only in the case of multiplier contracts
    if (['MULTUP', 'MULTDOWN'].includes(contract_type)) {
        buy.parameters.duration = undefined;
        buy.parameters.duration_unit = undefined;

        buy.parameters.multiplier = trade_option.multiplier;
    }
    // This will be required only in the case of accumulator contracts
    if (['ACCU'].includes(contract_type)) {
        buy.parameters.duration = undefined;
        buy.parameters.duration_unit = undefined;
        buy.parameters.growth_rate = trade_option.growth_rate;
    }
    return buy;
};

export const getDirection = ticks => {
    const { length } = ticks;
    const [tickOld, tickNew] = ticks.slice(-2);

    let direction = '';
    if (length >= 2) {
        direction = tickOld.quote < tickNew.quote ? 'rise' : direction;
        direction = tickOld.quote > tickNew.quote ? 'fall' : direction;
    }

    return direction;
};

export const getLastDigit = tick => {
    let number_string = tick;
    if (typeof number_string === 'number') {
        number_string = String(number_string);
    }
    return Number(number_string[number_string.length - 1]);
};

export const getLastDigitForList = (tick, pip_size = 0) => {
    const value = Number(tick).toFixed(pip_size);
    return value[value.length - 1];
};

const request_types = [
    'active_symbols',
    'authorize',
    'balance',
    'buy',
    'cancel',
    'contracts_for',
    'forget',
    'forget_all',
    'history',
    'ping',
    'portfolio',
    'proposal',
    'proposal_open_contract',
    'sell',
    'statement',
    'ticks',
    'ticks_history',
    'time',
    'transaction',
    'trading_times',
];

const redactSensitiveText = value =>
    String(value)
        .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
        .replace(
            /\b(access[_-]?token|api[_-]?token|refresh[_-]?token|authorization|token|password|secret)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
            '$1$2[redacted]'
        )
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .slice(0, 400);

export const getRequestErrorDetails = error_obj => {
    const response_error = error_obj?.error && typeof error_obj.error === 'object' ? error_obj.error : {};
    const echo_req = error_obj?.echo_req || response_error.echo_req || {};
    const explicit_message_type = response_error.msg_type || error_obj?.msg_type;
    const inferred_message_type = request_types.find(type => Object.prototype.hasOwnProperty.call(echo_req, type));
    const message_type = request_types.includes(explicit_message_type)
        ? explicit_message_type
        : inferred_message_type || 'unknown';
    const code = response_error.code || error_obj?.code || '';
    const raw_message = response_error.message || error_obj?.message || '';
    const request_id = Number.isFinite(echo_req?.req_id) ? String(echo_req.req_id) : '';

    return {
        message_type,
        code,
        safe_code: code ? redactSensitiveText(code) : '',
        message: raw_message ? redactSensitiveText(raw_message) : '',
        request_id,
    };
};

const getBackoffDelayInMs = (error_obj, delay_index) => {
    const base_delay = 2.5;
    const max_delay = 15;
    const next_delay_in_seconds = Math.min(base_delay * delay_index, max_delay);

    const { code, safe_code, message, message_type, request_id } = getRequestErrorDetails(error_obj);
    const error_details = [
        request_id && `request ID: ${request_id}`,
        safe_code && `code: ${safe_code}`,
        message && `server: ${message}`,
    ]
        .filter(Boolean)
        .join(' | ');
    const error_details_suffix = error_details ? ` (${error_details})` : '';
    let message_to_print = '';
    const trade_type_block = Blockly.derivWorkspace
        .getAllBlocks(true)
        .find(block => block.type === 'trade_definition_tradetype');
    const selected_trade_type = trade_type_block?.getFieldValue('TRADETYPECAT_LIST') || '';
    const { TRADE_TYPE_CATEGORY_NAMES } = config();

    if (code) {
        switch (code) {
            case 'RateLimit':
                message_to_print = localize(
                    'You are rate limited for: {{ message_type }}{{ details }}, retrying in {{ delay }}s (ID: {{ request }})',
                    {
                        message_type,
                        details: error_details_suffix,
                        delay: next_delay_in_seconds,
                        request: request_id || localize('unknown'),
                    }
                );

                break;
            case 'DisconnectError':
                message_to_print = localize('You are disconnected, retrying in {{ delay }}s', {
                    delay: next_delay_in_seconds,
                });
                break;
            case 'MarketIsClosed':
                message_to_print = localize('{{ message }}, retrying in {{ delay }}s', {
                    message: message || localize('The market is closed'),
                    delay: next_delay_in_seconds,
                });
                break;
            case 'OpenPositionLimitExceeded':
                message_to_print = localize(
                    'You already have an open position for {{ trade_type }} contract type, retrying in {{ delay }}s',
                    {
                        delay: next_delay_in_seconds,
                        trade_type: TRADE_TYPE_CATEGORY_NAMES?.[selected_trade_type] ?? '',
                    }
                );
                break;
            default:
                message_to_print = localize(
                    'Request failed for: {{ message_type }}{{ details }}, retrying in {{ delay }}s',
                    {
                        message_type,
                        details: error_details_suffix,
                        delay: next_delay_in_seconds,
                    }
                );
                break;
        }
    } else {
        message_to_print = localize(
            'Request failed for: {{ message_type }}{{ details }}, retrying in {{ delay }}s',
            {
                message_type,
                details: error_details_suffix,
                delay: next_delay_in_seconds,
            }
        );
    }

    logError(message_to_print);

    return next_delay_in_seconds * 1000;
};

export const updateErrorMessage = error => {
    if (error.error?.code === 'InputValidationFailed') {
        if (error.error.details?.duration) {
            error.error.message = localize('Duration must be a positive integer');
        }
        if (error.error.details?.amount) {
            error.error.message = localize('Amount must be a positive number.');
        }
    }
};

export const shouldThrowError = (error, errors_to_ignore = []) => {
    if (!error.error) {
        return false;
    }

    const default_errors_to_ignore = [
        'CallError',
        'WrongResponse',
        'GetProposalFailure',
        'RateLimit',
        'DisconnectError',
        'MarketIsClosed',
        'OpenPositionLimitExceeded',
    ];
    updateErrorMessage(error);
    const is_ignorable_error = errors_to_ignore
        .concat(default_errors_to_ignore)
        .includes(error?.error?.code ?? error?.name);

    if (error.error?.code === 'OpenPositionLimitExceeded') globalObserver.emit('bot.recoverOpenPositionLimitExceeded');
    return !is_ignorable_error;
};

export const recoverFromError = (promiseFn, recoverFn, errors_to_ignore, delay_index, api_base) => {
    return new Promise((resolve, reject) => {
        const promise = promiseFn();

        if (promise) {
            promise.then(resolve).catch(error => {
                /**
                 * if bot is not running there is no point of recovering from error
                 * `!api_base.is_running` will check the bot status if it is not running it will kick out the control from loop
                 */
                if (shouldThrowError(error, errors_to_ignore) || (api_base && !api_base.is_running)) {
                    reject(error);
                    return;
                }
                recoverFn(
                    error?.error?.code ?? error?.name,
                    () =>
                        new Promise(recoverResolve => {
                            const getGlobalTimeouts = () => globalObserver.getState('global_timeouts') ?? [];

                            const timeout = setTimeout(
                                () => {
                                    const global_timeouts = getGlobalTimeouts();
                                    delete global_timeouts[timeout];
                                    globalObserver.setState(global_timeouts);
                                    recoverResolve();
                                },
                                getBackoffDelayInMs(error, delay_index)
                            );

                            const global_timeouts = getGlobalTimeouts();
                            const cancellable_timeouts = ['buy'];
                            const msg_type = findValueByKeyRecursively(error, 'msg_type');

                            global_timeouts[timeout] = {
                                is_cancellable: cancellable_timeouts.includes(msg_type),
                                msg_type,
                            };

                            globalObserver.setState({ global_timeouts });
                        })
                );
            });
        } else {
            resolve();
        }
    });
};

/**
 * @param {*} promiseFn api call - it could be api call or subscription
 * @param {*} errors_to_ignore list of errors to ignore
 * @param {*} api_base instance of APIBase class to check if the bot is running or not
 * @returns a new promise
 */
export const doUntilDone = (promiseFn, errors_to_ignore, api_base) => {
    let delay_index = 1;

    return new Promise((resolve, reject) => {
        const recoverFn = (error_code, makeDelay) => {
            delay_index++;
            makeDelay().then(repeatFn);
        };

        const repeatFn = () => {
            recoverFromError(promiseFn, recoverFn, errors_to_ignore, delay_index, api_base).then(resolve).catch(reject);
        };

        repeatFn();
    });
};

export const createDetails = contract => {
    const { sell_price: sellPrice, buy_price: buyPrice, currency } = contract;
    const profit = getRoundedNumber(sellPrice - buyPrice, currency);
    const result = profit < 0 ? 'loss' : 'win';

    return [
        contract.transaction_ids.buy,
        +contract.buy_price,
        +contract.sell_price,
        profit,
        contract.contract_type,
        formatTime(parseInt(`${contract.entry_tick_time}000`), 'HH:mm:ss'),
        +contract.entry_tick,
        formatTime(parseInt(`${contract.exit_tick_time}000`), 'HH:mm:ss'),
        +contract.exit_tick,
        +(contract.barrier ? contract.barrier : 0),
        result,
    ];
};

export const getUUID = () => `${new Date().getTime() * Math.random()}`;

const hasBlockOfType = (targetType, workspace) => {
    const allBlocks = workspace.getAllBlocks();
    return allBlocks.some(block => block.type === targetType && !!block.parentBlock_);
};

export const checkBlocksForProposalRequest = () => {
    const workspace = window.Blockly.derivWorkspace;
    const has_payout_block = hasBlockOfType('payout', workspace);

    // Code for the future for case when basis: 'payout':
    // * Since basis : '${block.type === 'trade_definition_tradeoptions' ? 'stake' : 'payout'}'
    // * basis: 'payout' when contract_type: "MULTUP"
    // Uncomment next line later:
    // const is_basis_payout = !hasBlockOfType('trade_definition_tradeoptions', workspace);

    return {
        has_payout_block,
        is_basis_payout: false,
    };
};

export const socket_state = {
    [WebSocket.CONNECTING]: 'Connecting',
    [WebSocket.OPEN]: 'Connected',
    [WebSocket.CLOSING]: 'Closing',
    [WebSocket.CLOSED]: 'Closed',
};
