const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 10000;

const CLIENT_ID = '34sjwoq60wWXtuzTmSvxN';

const DIST_DIR = path.join(__dirname, 'dist');

const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

const readBody = req =>
    new Promise((resolve, reject) => {
        let body = '';

        req.on('data', chunk => {
            body += chunk;
        });

        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (error) {
                reject(error);
            }
        });

        req.on('error', reject);
    });

const server = http.createServer(async (req, res) => {
    try {
        // OAuth token exchange
        if (req.method === 'POST' && req.url === '/oauth/token') {
            console.info('[OAuthTrace] token_exchange.received');
            const body = await readBody(req);

            const { code, code_verifier, redirect_uri } = body;

            if (!code || !code_verifier || !redirect_uri) {
                res.writeHead(400, {
                    'Content-Type': 'application/json',
                });

                res.end(
                    JSON.stringify({
                        error: 'Missing OAuth parameters',
                    })
                );

                return;
            }

            let requestedRedirect;
            try {
                requestedRedirect = new URL(redirect_uri);
            } catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid OAuth redirect URI' }));
                return;
            }

            const forwardedHost = req.headers['x-forwarded-host'];
            const requestHost = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) || req.headers.host;
            const forwardedProto = req.headers['x-forwarded-proto'];
            const requestProtocol = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto) ||
                (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(requestHost || '') ? 'http' : 'https');
            const expectedRedirect = `${requestProtocol.split(',')[0]}://${requestHost}/callback`;

            if (
                !requestHost ||
                requestedRedirect.origin + requestedRedirect.pathname !== expectedRedirect ||
                requestedRedirect.search ||
                requestedRedirect.hash
            ) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'OAuth redirect URI must match this application origin' }));
                return;
            }

            console.info('[OAuthTrace] deriv_token_request.start');
            const derivTokenRequestStartedAt = Date.now();
            const tokenResponse = await fetch('https://auth.deriv.com/oauth2/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    client_id: CLIENT_ID,
                    code,
                    redirect_uri,
                    code_verifier,
                }),
                signal: AbortSignal.timeout(25_000),
            });
            console.info('[OAuthTrace] deriv_token_response.received', {
                status: tokenResponse.status,
                duration_ms: Date.now() - derivTokenRequestStartedAt,
            });

            const tokenData = await tokenResponse.json();

            if (!tokenResponse.ok) {
                res.writeHead(tokenResponse.status, {
                    'Content-Type': 'application/json',
                });

                res.end(JSON.stringify(tokenData));

                return;
            }

            res.writeHead(200, {
                'Content-Type': 'application/json',
            });

            res.end(JSON.stringify(tokenData));

            return;
        }

        // Serve static files
        const requestUrl = new URL(req.url, 'http://localhost');
        let requestPath = decodeURIComponent(requestUrl.pathname);

        if (requestPath === '/') {
            requestPath = '/index.html';
        }

        let filePath = path.resolve(DIST_DIR, `.${requestPath}`);
        const relativePath = path.relative(DIST_DIR, filePath);

        if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
            filePath = path.join(DIST_DIR, 'index.html');
        }

        const ext = path.extname(filePath);
        const contentType = mimeTypes[ext] || 'application/octet-stream';

        res.writeHead(200, {
            'Content-Type': contentType,
        });

        fs.createReadStream(filePath).pipe(res);
    } catch (error) {
        console.error('[Server]', error);

        res.writeHead(500, {
            'Content-Type': 'application/json',
        });

        res.end(
            JSON.stringify({
                error: 'Internal server error',
            })
        );
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
