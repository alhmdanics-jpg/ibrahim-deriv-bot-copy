import { getAppId, getSocketURL } from '@/components/shared';
import { website_name } from '@/utils/site-config';
import DerivAPIBasic from '@deriv/deriv-api/dist/DerivAPIBasic';
import { getInitialLanguage } from '@deriv-com/translations';
import APIMiddleware from './api-middleware';

const OPTIONS_API_URL = 'https://api.derivws.com/trading/v1/options';
const OPTIONS_PUBLIC_WEBSOCKET_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';

const getOptionsApiJson = async (response, action) => {
    const result = await response.json();
    if (!response.ok) {
        const message = result?.errors?.[0]?.message || `${action} failed with HTTP ${response.status}`;
        throw new Error(message);
    }
    return result;
};

export const isOAuthAccessToken = token => Boolean(token && token === localStorage.getItem('callback_token'));

export const getOAuthOptionsAccounts = async accessToken => {
    console.info('[OAuthTrace] accounts_rest.request');
    const startedAt = Date.now();
    const response = await fetch(`${OPTIONS_API_URL}/accounts`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(30_000),
    });
    console.info('[OAuthTrace] accounts_rest.response', {
        status: response.status,
        duration_ms: Date.now() - startedAt,
    });
    const result = await getOptionsApiJson(response, 'Options accounts request');
    const accounts = Array.isArray(result?.data)
        ? result.data
        : Array.isArray(result?.data?.accounts)
          ? result.data.accounts
          : result?.data
            ? [result.data]
            : [];

    return accounts.filter(account => account?.account_id && account?.account_type);
};

export const getOAuthOptionsWebSocketUrl = async (accessToken, accountId) => {
    if (!accountId) throw new Error('The active Options account ID is missing.');

    console.info('[OAuthTrace] otp.request');
    const startedAt = Date.now();
    const response = await fetch(`${OPTIONS_API_URL}/accounts/${encodeURIComponent(accountId)}/otp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(30_000),
    });
    console.info('[OAuthTrace] otp.response', {
        status: response.status,
        duration_ms: Date.now() - startedAt,
    });
    const result = await getOptionsApiJson(response, 'Options WebSocket OTP request');
    const websocketUrl = result?.data?.url;

    if (typeof websocketUrl !== 'string' || !websocketUrl.startsWith('wss://')) {
        throw new Error('Deriv did not return a valid authenticated WebSocket URL.');
    }

    return websocketUrl;
};

export const generateDerivApiInstance = (authenticatedWebSocketUrl = '') => {
    const cleanedServer = getSocketURL().replace(/[^a-zA-Z0-9.]/g, '');
    const cleanedAppId = getAppId()?.replace?.(/[^a-zA-Z0-9]/g, '') ?? getAppId();
    const socket_url = authenticatedWebSocketUrl || `wss://${cleanedServer}/websockets/v3?app_id=${cleanedAppId}&l=${getInitialLanguage()}&brand=${website_name.toLowerCase()}`;
    const deriv_socket = new WebSocket(socket_url);
    deriv_socket.addEventListener('open', () => console.info('[OAuthTrace] WebSocket open'));
    deriv_socket.addEventListener('error', () => console.info('[OAuthTrace] WebSocket error'));
    deriv_socket.addEventListener('close', () => console.info('[OAuthTrace] WebSocket close'));
    const deriv_api = new DerivAPIBasic({
        connection: deriv_socket,
        middleware: new APIMiddleware({}),
    });
    return deriv_api;
};

export const generateMarketDataApiInstance = (useFallbackEndpoint = false) => {
    const marketDataServer = getSocketURL().replace(/[^a-zA-Z0-9.]/g, '');
    const cleanedAppId = getAppId()?.replace?.(/[^a-zA-Z0-9]/g, '') ?? getAppId();
    const socket_url = useFallbackEndpoint
        ? 'wss://ws.binaryws.com/websockets/v3'
        : `wss://${marketDataServer}/websockets/v3?app_id=${cleanedAppId}&l=${getInitialLanguage()}&brand=${website_name.toLowerCase()}`;
    return generateDerivApiInstance(socket_url);
};

export const generateOAuthDerivApiInstance = async (accessToken, accountId) => {
    const websocketUrl = await getOAuthOptionsWebSocketUrl(accessToken, accountId);
    const api = generateDerivApiInstance(websocketUrl);
    console.info('[OAuthTrace] api_instance.created');
    return api;
};

export const generatePublicDerivApiInstance = () => generateDerivApiInstance(OPTIONS_PUBLIC_WEBSOCKET_URL);

export const getLoginId = () => {
    const login_id = localStorage.getItem('active_loginid');
    if (login_id && login_id !== 'null') return login_id;
    return null;
};

export const V2GetActiveToken = () => {
    const active_loginid = localStorage.getItem('active_loginid');
    let token = localStorage.getItem('authToken');

    try {
        const accounts = JSON.parse(localStorage.getItem('accountsList') || '{}');
        if (active_loginid && accounts?.[active_loginid]) {
            token = accounts[active_loginid];
        }
    } catch (error) {
        console.error('Unable to read active Deriv account token:', error);
    }

    const expiresAt = Number(localStorage.getItem('authTokenExpiresAt'));
    const oauthToken = localStorage.getItem('callback_token');
    if (token && token === oauthToken && expiresAt && Date.now() >= expiresAt) {
        return null;
    }

    if (token && token !== 'null') return token;
    return null;
};

export const V2GetActiveClientId = () => {
    const token = V2GetActiveToken();

    if (!token) return null;
    let account_list;
    try {
        account_list = JSON.parse(localStorage.getItem('accountsList') || '{}');
    } catch (error) {
        console.error('Unable to read Deriv accounts:', error);
        return null;
    }
    if (account_list && account_list !== 'null') {
        const active_loginid = getLoginId();
        if (active_loginid && account_list[active_loginid] === token) {
            return active_loginid;
        }
        const active_clientId = Object.keys(account_list).find(key => account_list[key] === token);
        return active_clientId;
    }
    return null;
};

export const getToken = () => {
    const active_loginid = getLoginId();
    const client_accounts = JSON.parse(localStorage.getItem('accountsList')) ?? undefined;
    const active_account = (client_accounts && client_accounts[active_loginid]) || {};
    return {
        token: active_account ?? undefined,
        account_id: active_loginid ?? undefined,
    };
};
