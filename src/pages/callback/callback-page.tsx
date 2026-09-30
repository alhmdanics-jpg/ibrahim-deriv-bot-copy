import { useEffect, useState } from 'react';
import { Button } from '@deriv-com/ui';

const CALLBACK_ENDPOINT = '/oauth/token';

const CallbackPage = () => {
    const [error, setError] = useState<string>('');
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const exchangeCode = async () => {
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

                localStorage.setItem('authToken', result.access_token);

                if (result.loginid) {
                    localStorage.setItem('active_loginid', result.loginid);
                }

                if (result.accounts) {
                    localStorage.setItem('accountsList', JSON.stringify(result.accounts));
                }

                sessionStorage.removeItem('oauth_state');
                sessionStorage.removeItem('oauth_code_verifier');
                sessionStorage.removeItem('oauth_redirect_uri');

                window.location.replace(`${window.location.origin}/bot/`);
            } catch (err) {
                console.error('[OAuth Callback]', err);
                setError(err instanceof Error ? err.message : 'OAuth login failed.');
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
