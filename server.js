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
                'Access-Control-Allow-Origin': '*',
            });

            res.end(JSON.stringify(tokenData));

            return;
        }

        // Serve static files
        let requestPath = decodeURIComponent(req.url.split('?')[0]);

        if (requestPath === '/') {
            requestPath = '/index.html';
        }

        let filePath = path.join(DIST_DIR, requestPath);

        if (!filePath.startsWith(DIST_DIR)) {
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
