import { useEffect, useState } from 'react';
import { Button } from '@deriv-com/ui';
import { generateDerivApiInstance } from '@/external/bot-skeleton/services/api/appId';

const CALLBACK_ENDPOINT = '/oauth/token';

const CallbackPage = () => {
    const [error, setError] = useState<string>('');
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const exchangeCode = async () => {
            let api: any = null;

            try {
                const params = new URLSearchParams(window.location.search);

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

                const response = await fetch(CALLBACK_ENDPOINT, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        code,
                        code_verifier: codeVerifier,
                        redirect_uri: redirectUri,
                    }),
                });

                const result = await response.json();

                if (!response.ok || !result.access_token) {
                    throw new Error(result.error || 'OAuth token exchange failed.');
                }

                const access_token = result.access_token;

                localStorage.setItem('authToken', access_token);

                api = await generateDerivApiInstance();

                if (!api) {
                    throw new Error('Unable to initialize Deriv API.');
                }

                const authorize_response = await api.authorize(access_token);

                if (authorize_response?.error) {
                    throw new Error(
                        authorize_response.error.message || 'Deriv authorization failed.'
                    );
                }

                const authorize = authorize_response?.authorize;

                if (!authorize) {
                    throw new Error('Deriv authorization response is missing.');
                }

                const account_list = authorize.account_list || [];

                if (account_list.length === 0) {
                    throw new Error('No Deriv accounts were returned.');
                }

                const accountsList: Record<string, string> = {};
                const clientAccounts: Record<string, any> = {};

                account_list.forEach((account: any) => {
                    if (!account.loginid) return;

                    accountsList[account.loginid] = access_token;

                    clientAccounts[account.loginid] = {
                        loginid: account.loginid,
                        token: access_token,
                        currency: account.currency || '',
                        is_virtual: account.is_virtual ?? false,
                    };
                });

                const firstAccount = account_list[0];

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
                    firstAccount.loginid
                );

                localStorage.setItem(
                    'callback_token',
                    access_token
                );

                sessionStorage.removeItem('oauth_state');
                sessionStorage.removeItem('oauth_code_verifier');
                sessionStorage.removeItem('oauth_redirect_uri');

                if (api?.disconnect) {
                    api.disconnect();
                }

                const currency = firstAccount.currency || 'USD';

                window.location.replace(
                    `${window.location.origin}/bot/?account=${encodeURIComponent(currency)}`
                );
            } catch (err) {
                console.error('[OAuth Callback]', err);

                if (api?.disconnect) {
                    api.disconnect();
                }

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
