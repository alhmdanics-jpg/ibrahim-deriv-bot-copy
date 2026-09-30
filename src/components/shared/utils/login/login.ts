import { website_name } from '@/utils/site-config';
import { CookieStorage, isStorageSupported, LocalStore } from '../storage/storage';
import { getStaticUrl } from '../url';
export const redirectToLogin = (is_logged_in: boolean, language: string, has_params = true, redirect_delay = 0) => {
    if (!is_logged_in && isStorageSupported(sessionStorage)) {
        const l = window.location;
        const redirect_url = has_params ? window.location.href : `${l.protocol}//${l.host}${l.pathname}`;
        sessionStorage.setItem('redirect_url', redirect_url);
        setTimeout(async () => {
    const new_href = await loginUrl({ language });
    window.location.href = new_href;
}, redirect_delay);
    }
};

export const redirectToSignUp = () => {
    window.open(getStaticUrl('/signup/'));
};

type TLoginUrl = {
    language: string;
};

const OAUTH_CLIENT_ID = '34sjwoq60wWXtuzTmSvxN';

const generateRandomString = (length = 64) => {
    const array = new Uint8Array(length);
    crypto.getRandomValues(array);

    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
};

const generateCodeChallenge = async (verifier: string) => {
    const data = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);

    const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));

    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const loginUrl = async ({ language }: TLoginUrl) => {
    const signup_device_cookie = new (CookieStorage as any)('signup_device');
    const signup_device = signup_device_cookie.get('signup_device');

    const date_first_contact_cookie = new (CookieStorage as any)('date_first_contact');
    const date_first_contact = date_first_contact_cookie.get('date_first_contact');

    const marketing_queries = `${signup_device ? `&signup_device=${signup_device}` : ''}${
        date_first_contact ? `&date_first_contact=${date_first_contact}` : ''
    }`;

    const state = generateRandomString(32);
    const code_verifier = generateRandomString(64);
    const code_challenge = await generateCodeChallenge(code_verifier);

    const redirect_uri = `${window.location.origin}/callback`;

    sessionStorage.setItem('oauth_state', state);
    sessionStorage.setItem('oauth_code_verifier', code_verifier);
    sessionStorage.setItem('oauth_redirect_uri', redirect_uri);

    const params = new URLSearchParams({
        response_type: 'code',
        client_id: OAUTH_CLIENT_ID,
        redirect_uri,
        scope: 'trade',
        state,
        code_challenge,
        code_challenge_method: 'S256',
        l: language,
        brand: website_name.toLowerCase(),
    });

    if (signup_device) {
        params.set('signup_device', signup_device);
    }

    if (date_first_contact) {
        params.set('date_first_contact', date_first_contact);
    }

    return `https://auth.deriv.com/oauth2/auth?${params.toString()}`;
};
