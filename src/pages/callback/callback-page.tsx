import { useEffect, useState } from 'react';
import { Button } from '@deriv-com/ui';
import { getOAuthOptionsAccounts } from '@/external/bot-skeleton/services/api/appId';

const CALLBACK_ENDPOINT = '/oauth/token';
const DIAGNOSTIC_TIMEOUT_MS = 30_000;

const logOAuthTrace = (event: string, details: Record<string, unknown> = {}) => {
    console.info(`[OAuthTrace] ${event}`, details);
};

const withDiagnosticTimeout = <T,>(promise: Promise<T>, stage: string) =>
    new Promise<T>((resolve, reject) => {
        const timeoutId = window.setTimeout(
            () => reject(new Error(`${stage} timed out after ${DIAGNOSTIC_TIMEOUT_MS / 1000} seconds.`)),
            DIAGNOSTIC_TIMEOUT_MS
        );

        promise.then(
            value => {
                window.clearTimeout(timeoutId);
                resolve(value);
            },
            error => {
                window.clearTimeout(timeoutId);
                reject(error);
            }
        );
    });

const CallbackPage = () => {
    const [error, setError] = useState<string>('');
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const exchangeCode = async () => {
            logOAuthTrace('callback.start');

            try {
                const params = new URLSearchParams(window.location.search);

                const oauthError = params.get('error');
                if (oauthError) {
                    throw new Error(params.get('error_description') || `Deriv OAuth failed: ${oauthError}`);
                }

                const code = params.get('code');
                const state = params.get('state');

                const savedState = sessionStorage.getItem('oauth_state');
                const codeVerifier = sessionStorage.getItem('oauth_code_verifier');
                const redirectUri = sessionStorage.getItem('oauth_redirect_uri');

                if (!code) {
                    throw new Error('OAuth authorization code is missing.');
                }

                if (!state || !savedState || state !== savedState) {
                    throw new Error('Invalid OAuth state.');
                }

                if (!codeVerifier) {
                    throw new Error('OAuth code verifier is missing.');
                }

                if (!redirectUri) {
                    throw new Error('OAuth redirect URI is missing.');
                }

                logOAuthTrace('token_request.start');
                const tokenRequestStartedAt = Date.now();
                const response = await withDiagnosticTimeout(fetch(CALLBACK_ENDPOINT, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        code,
                        code_verifier: codeVerifier,
                        redirect_uri: redirectUri,
                    }),
                }), 'OAuth token request');
                logOAuthTrace('token_response.received', {
                    status: response.status,
                    duration_ms: Date.now() - tokenRequestStartedAt,
                });

                const result = await withDiagnosticTimeout(response.json(), 'OAuth token response parsing');
                logOAuthTrace('token_json.parsed', { has_access_token: Boolean(result?.access_token) });

                if (!response.ok || !result.access_token) {
                    const exchangeError =
                        (typeof result.error === 'string' && result.error) ||
                        result.error_description ||
                        result.error?.message ||
                        'OAuth token exchange failed.';
                    throw new Error(exchangeError);
                }

                const access_token = result.access_token;
                logOAuthTrace('token_exchange.success');

                const account_list = await withDiagnosticTimeout(
                    getOAuthOptionsAccounts(access_token),
                    'Options accounts request'
                );
                logOAuthTrace('accounts.selected_count', { account_count: account_list.length });

                if (account_list.length === 0) throw new Error('No Deriv Options accounts were returned.');

                const accountsList: Record<string, string> = {};
                const clientAccounts: Record<string, any> = {};

                account_list.forEach((account: any) => {
                    accountsList[account.account_id] = access_token;

                    clientAccounts[account.account_id] = {
                        account_id: account.account_id,
                        loginid: account.account_id,
                        token: access_token,
                        currency: account.currency || 'USD',
                        is_virtual: account.account_type === 'demo' ? 1 : 0,
                        is_disabled: account.status === 'active' ? 0 : 1,
                        account_type: account.account_type,
                        account_category: 'options',
                        broker: 'deriv',
                        created_at: 0,
                        currency_type: 'fiat',
                        landing_company_name: '',
                        linked_to: [],
                        balance: account.balance,
                        is_options_account: true,
                        options_account_id: account.account_id,
                    };
                });

                const requestedAccount = sessionStorage.getItem('oauth_account') || '';
                const requestedIsDemo = requestedAccount.toLowerCase() === 'demo';
                const matchingRequestedAccount = requestedIsDemo
                    ? account_list.find((account: any) => account.account_type === 'demo')
                    : account_list.find(
                          (account: any) =>
                              account.account_type === 'real' &&
                              account.currency?.toUpperCase() === requestedAccount.toUpperCase()
                      );
                const activeAccount = matchingRequestedAccount ||
                    (!requestedAccount
                        ? account_list.find((account: any) => account.account_type === 'demo') || account_list[0]
                        : null) ||
                    (account_list.length === 1 ? account_list[0] : null);

                if (!activeAccount?.account_id) {
                    throw new Error(`No Options account matches the requested ${requestedIsDemo ? 'demo' : 'real'} account.`);
                }
                logOAuthTrace('account.selected', { account_type: activeAccount.account_type });

                localStorage.setItem('authToken', access_token);
                localStorage.setItem(
                    'authTokenExpiresAt',
                    String(Date.now() + Number(result.expires_in || 3600) * 1000)
                );

                localStorage.setItem(
                    'accountsList',
                    JSON.stringify(accountsList)
                );

                localStorage.setItem(
                    'clientAccounts',
                    JSON.stringify(clientAccounts)
                );

                localStorage.setItem(
                    'active_loginid',
                    activeAccount.account_id
                );

                localStorage.setItem(
                    'callback_token',
                    access_token
                );

                sessionStorage.removeItem('oauth_state');
                sessionStorage.removeItem('oauth_code_verifier');
                sessionStorage.removeItem('oauth_redirect_uri');
                sessionStorage.removeItem('oauth_account');

                const accountParam = activeAccount.account_type === 'demo'
                    ? 'demo'
                    : activeAccount.currency || 'USD';

                window.location.replace(
                    `${window.location.origin}/?account=${encodeURIComponent(accountParam)}`
                );
            } catch (err) {
                console.error('[OAuth Callback]', err);

                sessionStorage.removeItem('oauth_state');
                sessionStorage.removeItem('oauth_code_verifier');
                sessionStorage.removeItem('oauth_redirect_uri');
                sessionStorage.removeItem('oauth_account');

                setError(
                    err instanceof Error
                        ? err.message
                        : 'OAuth login failed.'
                );
            } finally {
                setLoading(false);
            }
        };

        exchangeCode();
    }, []);

    if (loading) {
        return <div style={{ padding: 40 }}>Signing in...</div>;
    }

    if (error) {
        return (
            <div style={{ padding: 40 }}>
                <h2>Login failed</h2>
                <p>{error}</p>

                <Button onClick={() => (window.location.href = '/')}>
                    Return to Bot
                </Button>
            </div>
        );
    }

    return null;
};

export default CallbackPage;
