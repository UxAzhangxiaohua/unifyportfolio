const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const DIST = path.join(__dirname, 'dist');
// Production: 8188 → 8189. The dev test instance (scripts/dev.sh) overrides these via env
const PORT = Number(process.env.FRONTEND_PORT) || 8188;
const HOST = process.env.BIND_HOST || '0.0.0.0';
const API_TARGET = process.env.API_TARGET || 'http://127.0.0.1:8189';

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  // Proxy /api requests to backend
  if (req.url.startsWith('/api')) {
    const target = new URL(req.url, API_TARGET);
    const proxyReq = http.request(target, { method: req.method, headers: req.headers }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => {
      res.writeHead(502);
      res.end('Backend unavailable');
    });
    req.pipe(proxyReq);
    return;
  }

  // Serve static files
  let filePath = path.join(DIST, req.url === '/' ? 'index.html' : req.url);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(DIST, 'index.html'); // SPA fallback
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Frontend serving on http://${HOST}:${PORT}, proxying /api to ${API_TARGET}`);
});
