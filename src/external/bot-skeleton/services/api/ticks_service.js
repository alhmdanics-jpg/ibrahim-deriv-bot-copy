/* eslint-disable no-confusing-arrow */
import { Map } from 'immutable';
import { clearAuthData } from '@/utils/auth-utils';
import { getLast, historyToTicks } from '../../utils/binary-utils';
import { observer as globalObserver } from '../../utils/observer';
import { doUntilDone, getUUID } from '../tradeEngine/utils/helpers';
import { api_base } from './api-base';

const parseTick = tick => ({
    epoch: +tick.epoch,
    quote: +tick.quote,
});

const parseOhlc = ohlc => ({
    open: +ohlc.open,
    high: +ohlc.high,
    low: +ohlc.low,
    close: +ohlc.close,
    epoch: +(ohlc.open_time || ohlc.epoch),
});

const parseCandles = candles => candles.map(t => parseOhlc(t));

const updateTicks = (ticks, newTick) => (getLast(ticks).epoch >= newTick.epoch ? ticks : [...ticks.slice(1), newTick]);

const updateCandles = (candles, ohlc) => {
    const lastCandle = getLast(candles);
    if (
        (lastCandle.open === ohlc.open &&
            lastCandle.high === ohlc.high &&
            lastCandle.low === ohlc.low &&
            lastCandle.close === ohlc.close &&
            lastCandle.epoch === ohlc.epoch) ||
        lastCandle.epoch > ohlc.epoch
    ) {
        return candles;
    }
    const prevCandles = lastCandle.epoch === ohlc.epoch ? candles.slice(0, -1) : candles.slice(1);
    return [...prevCandles, ohlc];
};

const getType = isCandle => (isCandle ? 'candles' : 'ticks');

export default class TicksService {
    constructor() {
        this.ticks = new Map();
        this.candles = new Map();
        this.tickListeners = new Map();
        this.ohlcListeners = new Map();
        this.subscriptions = new Map();
        this.ticks_history_promise = null;
        this.active_symbols_promise = null;
        this.candles_promise = null;

        this.observe();
    }

    requestPipSizes() {
        if (this.pipSizes) {
            return Promise.resolve(this.pipSizes);
        }

        if (!this.active_symbols_promise) {
            this.active_symbols_promise = new Promise(resolve => {
                this.pipSizes = api_base.pip_sizes;
                resolve(this.pipSizes);
            });
        }
        return this.active_symbols_promise;
    }

    async request(options) {
        return new Promise((resolve, reject) => {
            const { symbol, granularity } = options;

            const style = getType(granularity);

            if (style === 'ticks' && this.ticks.has(symbol)) {
                return resolve(this.ticks.get(symbol));
            }

            if (style === 'candles' && this.candles.hasIn([symbol, Number(granularity)])) {
                return resolve(this.candles.getIn([symbol, Number(granularity)]));
            }
            this.requestStream({ ...options, style })
                .then(res => {
                    resolve(res);
                })
                .catch(e => {
                    reject(e);
                });
        });
    }

    monitor(options) {
        return new Promise((resolve, reject) => {
            const { symbol, granularity, callback } = options;

            const type = getType(granularity);

            const key = getUUID();
            this.request(options)
                .then(() => {
                    if (type === 'ticks') {
                        this.tickListeners = this.tickListeners.setIn([symbol, key], callback);
                        globalObserver.emit('bot.bot_ready');
                        api_base.toggleRunButton(false);
                    } else {
                        this.ohlcListeners = this.ohlcListeners.setIn([symbol, Number(granularity), key], callback);
                    }
                    resolve(key);
                })
                .catch(e => {
                    globalObserver.emit('Error', e);
                    this.ticks_history_promise = null;
                    api_base.toggleRunButton(false);
                    reject(e);
                });
        });
    }

    async stopMonitor(options) {
        const { symbol, granularity, key } = options;
        const type = getType(granularity);

        if (type === 'ticks' && this.tickListeners.hasIn([symbol, key])) {
            this.tickListeners = this.tickListeners.deleteIn([symbol, key]);
        }

        if (type === 'candles' && this.ohlcListeners.hasIn([symbol, Number(granularity), key])) {
            this.ohlcListeners = this.ohlcListeners.deleteIn([symbol, Number(granularity), key]);
        }

        await this.unsubscribeIfEmptyListeners(options);
    }

    async unsubscribeIfEmptyListeners(options) {
        const { symbol, granularity } = options;
        const type = getType(granularity);
        let subscription_id;

        if (type === 'ticks') {
            const tickListener = this.tickListeners.get(symbol);
            if (!tickListener || tickListener.size) return;

            this.tickListeners = this.tickListeners.delete(symbol);
            this.ticks = this.ticks.delete(symbol);
            subscription_id = this.subscriptions.getIn(['tick', symbol]);
            this.subscriptions = this.subscriptions.deleteIn(['tick', symbol]);
            if (this.ticks_history_promise?.stringified_options === JSON.stringify({ symbol, style: 'ticks' })) {
                this.ticks_history_promise = null;
            }
        } else {
            const address = [symbol, Number(granularity)];
            const ohlcListener = this.ohlcListeners.getIn(address);
            if (!ohlcListener || ohlcListener.size) return;

            this.ohlcListeners = this.ohlcListeners.deleteIn(address);
            this.candles = this.candles.deleteIn(address);
            subscription_id = this.subscriptions.getIn(['ohlc', ...address]);
            this.subscriptions = this.subscriptions.deleteIn(['ohlc', ...address]);
            if (
                this.candles_promise?.stringified_options ===
                JSON.stringify({ symbol, granularity, style: 'candles' })
            ) {
                this.candles_promise = null;
            }
        }

        if (subscription_id) {
            await doUntilDone(() => api_base.api?.forget(subscription_id));
        }
    }

    updateTicksAndCallListeners(symbol, ticks) {
        if (this.ticks.get(symbol) === ticks) {
            return;
        }
        this.ticks = this.ticks.set(symbol, ticks);

        const listeners = this.tickListeners.get(symbol);

        if (listeners) {
            listeners.forEach(callback => callback(this.ticks.get(symbol)));
        }
    }

    updateCandlesAndCallListeners(address, candles) {
        if (this.ticks.getIn(address) === candles) {
            return;
        }
        this.candles = this.candles.setIn(address, candles);

        const listeners = this.ohlcListeners.getIn(address);

        if (listeners) {
            listeners.forEach(callback => callback(this.candles.getIn(address)));
        }
    }

    observe() {
        if (api_base.api) {
            api_base.subscribeToMessages(({ data }) => {
                if (data.msg_type === 'tick') {
                    const { tick, subscription } = data;
                    const { symbol } = tick;
                    if (this.ticks.has(symbol)) {
                        if (subscription?.id) {
                            this.subscriptions = this.subscriptions.setIn(['tick', symbol], subscription.id);
                        }
                        this.updateTicksAndCallListeners(symbol, updateTicks(this.ticks.get(symbol), parseTick(tick)));
                    }
                }

                if (data.msg_type === 'ohlc') {
                    const { ohlc, subscription } = data;
                    const { symbol, granularity } = ohlc;
                    if (this.candles.hasIn([symbol, Number(granularity)])) {
                        if (subscription?.id) {
                            this.subscriptions = this.subscriptions.setIn(
                                ['ohlc', symbol, Number(granularity)],
                                subscription.id
                            );
                        }
                        const address = [symbol, Number(granularity)];
                        this.updateCandlesAndCallListeners(
                            address,
                            updateCandles(this.candles.getIn(address), parseOhlc(ohlc))
                        );
                    }
                }
            });
        }
    }

    requestStream(options) {
        const { style } = options;
        const stringified_options = JSON.stringify(options);

        if (style === 'ticks') {
            if (this.ticks_history_promise?.stringified_options !== stringified_options) {
                this.ticks_history_promise = {
                    promise: this.requestPipSizes().then(() => this.requestTicks(options)),
                    stringified_options,
                };
            }

            return this.ticks_history_promise.promise;
        }

        if (style === 'candles') {
            if (!this.candles_promise || this.candles_promise.stringified_options !== stringified_options) {
                this.candles_promise = {
                    promise: this.requestPipSizes().then(() => this.requestTicks(options)),
                    stringified_options,
                };
            }

            return this.candles_promise.promise;
        }

        return [];
    }

    requestTicks(options) {
        const { symbol, granularity, style } = options;
        const request_object = {
            ticks_history: symbol === 'na' ? 'R_100' : symbol,
            subscribe: 1,
            end: 'latest',
            count: 1000,
            granularity: granularity ? Number(granularity) : undefined,
            style,
        };
        return new Promise((resolve, reject) => {
            if (!api_base.api) resolve([]);
            doUntilDone(() => api_base.api.send(request_object), [], api_base)
                .then(r => {
                    if (r.subscription?.id) {
                        this.subscriptions =
                            style === 'ticks'
                                ? this.subscriptions.setIn(['tick', symbol], r.subscription.id)
                                : this.subscriptions.setIn(['ohlc', symbol, Number(granularity)], r.subscription.id);
                    }
                    if (style === 'ticks') {
                        const ticks = historyToTicks(r.history);

                        this.updateTicksAndCallListeners(symbol, ticks);
                        resolve(ticks);
                    } else {
                        const candles = parseCandles(r.candles);

                        this.updateCandlesAndCallListeners([symbol, Number(granularity)], candles);

                        resolve(candles);
                    }
                })
                .catch(error => {
                    if (error?.code === 'InvalidSymbol') {
                        clearAuthData();
                    }
                    reject(error);
                });
        });
    }

    forget = () => {
        return new Promise((resolve, reject) => {
            if (api_base?.api) {
                api_base.api
                    .forgetAll('ticks')
                    .then(() => {
                        resolve();
                    })
                    .catch(reject);
            } else {
                resolve();
            }
        });
    };

    forgetCandleSubscription = () => {
        return new Promise((resolve, reject) => {
            if (api_base?.api) {
                api_base.api
                    .forgetAll('candles')
                    .then(() => {
                        resolve();
                    })
                    .catch(reject);
            } else {
                resolve();
            }
        });
    };

    unsubscribeFromTicksService() {
        return new Promise((resolve, reject) => {
            this.forget()
                .then(() => {
                    this.forgetCandleSubscription()
                        .then(() => {
                            resolve();
                        })
                        .catch(reject);
                })
                .catch(reject);
            this.ticks_history_promise = null;
        });
    }
}
