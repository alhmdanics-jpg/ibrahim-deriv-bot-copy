import Cookies from 'js-cookie';
import CommonStore from '@/stores/common-store';
import { TAuthData } from '@/types/api-types';
import { clearAuthData } from '@/utils/auth-utils';
import { observer as globalObserver } from '../../utils/observer';
import { doUntilDone, socket_state } from '../tradeEngine/utils/helpers';
import {
    CONNECTION_STATUS,
    setAccountList,
    setAuthData,
    setConnectionStatus,
    setIsAuthorized,
    setIsAuthorizing,
} from './observables/connection-status-stream';
import ApiHelpers from './api-helpers';
import {
    generateDerivApiInstance,
    generateOAuthDerivApiInstance,
    isOAuthAccessToken,
    V2GetActiveClientId,
    V2GetActiveToken,
} from './appId';
import chart_api from './chart-api';

type CurrentSubscription = {
    id: string;
    unsubscribe: () => void;
};

type SubscriptionPromise = Promise<{
    subscription: CurrentSubscription;
}>;

type ApiMessage = any;
type ApiMessageListener = (message: ApiMessage) => void;

type TApiBaseApi = {
    connection: {
        readyState: keyof typeof socket_state;
        addEventListener: (event: string, callback: () => void) => void;
        removeEventListener: (event: string, callback: () => void) => void;
    };
    send: (data: unknown) => void;
    disconnect: () => void;
    authorize: (token: string) => Promise<{ authorize: TAuthData; error: unknown }>;
    getSelfExclusion: () => Promise<unknown>;
    onMessage: () => {
        subscribe: (callback: (message: unknown) => void) => {
            unsubscribe: () => void;
        };
    };
} & ReturnType<typeof generateDerivApiInstance>;

class APIBase {
    api: TApiBaseApi | null = null;
    token: string = '';
    account_id: string = '';
    pip_sizes = {};
    account_info = {};
    is_running = false;
    subscriptions: CurrentSubscription[] = [];
    messageListeners = new Set<ApiMessageListener>();
    time_interval: ReturnType<typeof setInterval> | null = null;
    has_active_symbols = false;
    is_stopping = false;
    active_symbols = [];
    current_auth_subscriptions: SubscriptionPromise[] = [];
    is_authorized = false;
    is_options_oauth = false;
    active_symbols_promise: Promise<void> | null = null;
    common_store: CommonStore | undefined;
    landing_company: string | null = null;

    unsubscribeAllSubscriptions = () => {
        this.current_auth_subscriptions?.forEach(subscription_promise => {
            subscription_promise.then(({ subscription }) => {
                if (subscription?.id) {
                    this.api?.send({
                        forget: subscription.id,
                    });
                }
            });
        });
        this.current_auth_subscriptions = [];
    };

    onsocketopen = () => {
        setConnectionStatus(CONNECTION_STATUS.OPENED);
    };

    onsocketclose = () => {
        setConnectionStatus(CONNECTION_STATUS.CLOSED);
        this.reconnectIfNotConnected();
    };

    async init(force_create_connection = false) {
        this.toggleRunButton(true);
        const activeToken = V2GetActiveToken();
        const isOptionsOAuth = isOAuthAccessToken(activeToken);

        if (this.api) {
            this.unsubscribeAllSubscriptions();
        }

        if (!this.api || this.api?.connection.readyState !== 1 || force_create_connection) {
            if (this.api?.connection) {
                ApiHelpers.disposeInstance();
                setConnectionStatus(CONNECTION_STATUS.CLOSED);
                this.subscriptions.forEach(subscription => subscription.unsubscribe());
                this.subscriptions = [];
                this.api.connection.removeEventListener('open', this.onsocketopen);
                this.api.connection.removeEventListener('close', this.onsocketclose);
                this.api.disconnect();
            }

            if (isOptionsOAuth && activeToken) {
                setIsAuthorizing(true);
                setIsAuthorized(false);
                this.is_authorized = false;
                try {
                    const accountId = V2GetActiveClientId();
                    this.account_id = accountId ?? '';
                    this.api = await generateOAuthDerivApiInstance(activeToken, accountId);
                    this.is_options_oauth = true;
                } catch (error) {
                    setConnectionStatus(CONNECTION_STATUS.CLOSED);
                    setIsAuthorized(false);
                    setIsAuthorizing(false);
                    globalObserver.emit('Error', error);
                    return;
                }
            } else {
                this.api = generateDerivApiInstance();
                this.is_options_oauth = false;
            }
            this.api?.connection.addEventListener('open', this.onsocketopen);
            this.api?.connection.addEventListener('close', this.onsocketclose);
            this.messageListeners.forEach(listener => {
                const subscription = this.api?.onMessage().subscribe(listener);
                if (subscription) this.subscriptions.push(subscription);
            });
        }

        if (!this.has_active_symbols && !V2GetActiveToken()) {
            this.active_symbols_promise = this.getActiveSymbols();
        }

        this.initEventListeners();

        if (this.time_interval) clearInterval(this.time_interval);
        this.time_interval = null;

        if (activeToken) {
            setIsAuthorizing(true);
            if (isOptionsOAuth) {
                await this.authorizeOptionsAccount(activeToken);
            } else {
                await this.authorizeAndSubscribe();
            }
        }

        chart_api.init(force_create_connection);
    }

    getConnectionStatus() {
        if (this.api?.connection) {
            const ready_state = this.api.connection.readyState;
            return socket_state[ready_state as keyof typeof socket_state] || 'Unknown';
        }
        return 'Socket not initialized';
    }

    terminate() {
        // eslint-disable-next-line no-console
        if (this.api) this.api.disconnect();
    }

    initEventListeners() {
        if (window) {
            window.addEventListener('online', this.reconnectIfNotConnected);
            window.addEventListener('focus', this.reconnectIfNotConnected);
        }
    }

    async createNewInstance(account_id: string) {
        if (this.account_id !== account_id) {
            await this.init();
        }
    }

    reconnectIfNotConnected = () => {
        // eslint-disable-next-line no-console
        console.log('connection state: ', this.api?.connection?.readyState);
        if (this.api?.connection?.readyState && this.api?.connection?.readyState > 1) {
            // eslint-disable-next-line no-console
            console.log('Info: Connection to the server was closed, trying to reconnect.');
            this.init(true);
        }
    };

    async authorizeAndSubscribe() {
        const token = V2GetActiveToken();
        if (!token || !this.api) return;
        this.token = token;
        this.account_id = V2GetActiveClientId() ?? '';
        setIsAuthorizing(true);
        setIsAuthorized(false);

        try {
            const { authorize, error } = await this.api.authorize(this.token);
            if (error) {
                if (error.code === 'InvalidToken') {
                    const is_tmb_enabled = window.is_tmb_enabled === true;
                    if (Cookies.get('logged_state') === 'true' && !is_tmb_enabled) {
                        globalObserver.emit('InvalidToken', { error });
                    } else {
                        clearAuthData();
                    }
                } else {
                    console.error('Authorization error:', error);
                }
                setIsAuthorizing(false);
                return error;
            }

            this.account_info = authorize;
            setAccountList(authorize?.account_list || []);
            setAuthData(authorize);
            setIsAuthorized(true);
            this.is_authorized = true;
            localStorage.setItem('client_account_details', JSON.stringify(authorize?.account_list));
            localStorage.setItem('client.country', authorize?.country);
            this.toggleRunButton(false);
            this.has_active_symbols = false;
            this.active_symbols_promise = this.getActiveSymbols().then(() => {
                // After getting active symbols, refresh them in the ApiHelpers instance too
                // Use type casting to fix TypeScript errors
                const apiHelpers = ApiHelpers.instance as any;
                if (apiHelpers?.active_symbols) {
                    apiHelpers.active_symbols.retrieveActiveSymbols(true).catch((error: Error) => {
                        console.error('[API] Failed to retrieve active symbols:', error);
                    });
                }
            });
            this.subscribe();
            // this.getSelfExclusion(); commented this so we dont call it from two places
        } catch (e) {
            console.error('Authorization failed:', e);
            this.is_authorized = false;
            clearAuthData();
            setIsAuthorized(false);
            globalObserver.emit('Error', e);
        } finally {
            setIsAuthorizing(false);
        }
    }

    async authorizeOptionsAccount(accessToken: string) {
        if (!this.api) return;

        try {
            await this.waitForConnectionOpen();
            const accounts = JSON.parse(localStorage.getItem('clientAccounts') || '{}');
            const activeAccount = accounts[this.account_id || V2GetActiveClientId() || ''];
            const accountList = Object.values(accounts).filter(
                (account: any) => account?.is_options_account
            ) as TAuthData['account_list'];

            if (!activeAccount || !accountList.length) {
                throw new Error('The selected Options account is missing from local account data.');
            }

            const authData = {
                account_list: accountList,
                balance: Number(activeAccount.balance || 0),
                country: '',
                currency: activeAccount.currency || 'USD',
                email: '',
                fullname: '',
                is_virtual: activeAccount.is_virtual ? 1 : 0,
                landing_company_fullname: '',
                landing_company_name: '',
                linked_to: [],
                local_currencies: {},
                loginid: activeAccount.loginid,
                preferred_language: '',
                scopes: ['trade'],
                upgradeable_landing_companies: [],
                user_id: 0,
                token: accessToken,
            } as TAuthData;

            this.account_id = activeAccount.loginid;
            this.account_info = authData;
            setAccountList(accountList);
            setAuthData(authData);
            setIsAuthorized(true);
            this.is_authorized = true;
            this.toggleRunButton(false);
            this.has_active_symbols = false;
            this.active_symbols_promise = this.getActiveSymbols().then(() => {
                const apiHelpers = ApiHelpers.instance as any;
                if (apiHelpers?.active_symbols) {
                    apiHelpers.active_symbols.retrieveActiveSymbols(true).catch((error: Error) => {
                        console.error('[API] Failed to retrieve active symbols:', error);
                    });
                }
            });
            this.subscribe();
        } catch (error) {
            this.is_authorized = false;
            setIsAuthorized(false);
            globalObserver.emit('Error', error);
        } finally {
            setIsAuthorizing(false);
        }
    }

    private waitForConnectionOpen() {
        const connection = this.api?.connection as unknown as WebSocket | undefined;
        if (!connection) return Promise.reject(new Error('Options WebSocket is unavailable.'));
        if (connection.readyState === WebSocket.OPEN) return Promise.resolve();

        return new Promise<void>((resolve, reject) => {
            const timeoutId = window.setTimeout(() => {
                cleanup();
                reject(new Error('Options WebSocket did not open within 30 seconds.'));
            }, 30_000);
            const cleanup = () => {
                window.clearTimeout(timeoutId);
                connection.removeEventListener('open', onOpen);
                connection.removeEventListener('error', onError);
                connection.removeEventListener('close', onClose);
            };
            const onOpen = () => {
                cleanup();
                resolve();
            };
            const onError = () => {
                cleanup();
                reject(new Error('Options WebSocket connection failed.'));
            };
            const onClose = () => {
                cleanup();
                reject(new Error('Options WebSocket closed before opening.'));
            };

            connection.addEventListener('open', onOpen, { once: true });
            connection.addEventListener('error', onError, { once: true });
            connection.addEventListener('close', onClose, { once: true });
        });
    }

    async getSelfExclusion() {
        if (!this.api || !this.is_authorized) return;
        await this.api.getSelfExclusion();
        // TODO: fix self exclusion
    }

    async subscribe() {
        const subscribeToStream = (streamName: string) => {
            return doUntilDone(
                () => {
                    const subscription = this.api?.send({
                        [streamName]: 1,
                        subscribe: 1,
                        ...(streamName === 'balance' && !this.is_options_oauth ? { account: 'all' } : {}),
                    });
                    if (subscription) {
                        this.current_auth_subscriptions.push(subscription);
                    }
                    return subscription;
                },
                [],
                this
            );
        };

        const streamsToSubscribe = ['balance', 'transaction', 'proposal_open_contract'];

        await Promise.all(streamsToSubscribe.map(subscribeToStream));
    }

    getActiveSymbols = async () => {
        const requestActiveSymbols = async () => {
            const response = await fetch('/api/market/active-symbols', {
                headers: { Accept: 'application/json' },
                cache: 'no-store',
            });
            const result = await response.json();
            if (!response.ok || result.error) throw new Error(result.error || 'Unable to retrieve market symbols.');
            return Array.isArray(result.active_symbols) ? result.active_symbols : [];
        };

        const active_symbols = await doUntilDone(() => requestActiveSymbols(), []);
        const pip_sizes = {};
        if (active_symbols.length) this.has_active_symbols = true;
        active_symbols.forEach(({ symbol, underlying_symbol, pip, pip_size }) => {
            const symbol_name = symbol ?? underlying_symbol;
            const pip_value = pip ?? pip_size;
            (pip_sizes as Record<string, number>)[symbol_name] = +(+pip_value).toExponential().substring(3);
        });
        this.pip_sizes = pip_sizes as Record<string, number>;
        this.toggleRunButton(false);
        this.active_symbols = active_symbols;
    };

    toggleRunButton = (toggle: boolean) => {
        const run_button = document.querySelector('#db-animation__run-button');
        if (!run_button) return;
        (run_button as HTMLButtonElement).disabled = toggle;
    };

    setIsRunning(toggle = false) {
        this.is_running = toggle;
    }

    pushSubscription(subscription: CurrentSubscription) {
        this.subscriptions.push(subscription);
    }

    subscribeToMessages(listener: ApiMessageListener) {
        this.messageListeners.add(listener);
        const subscription = this.api?.onMessage().subscribe(listener);
        if (subscription) this.subscriptions.push(subscription);
        return subscription;
    }

    clearSubscriptions() {
        this.subscriptions.forEach(s => s.unsubscribe());
        this.subscriptions = [];
        this.messageListeners.clear();

        // Resetting timeout resolvers
        const global_timeouts = globalObserver.getState('global_timeouts') ?? [];

        global_timeouts.forEach((_: unknown, i: number) => {
            clearTimeout(i);
        });
    }
}

export const api_base = new APIBase();
