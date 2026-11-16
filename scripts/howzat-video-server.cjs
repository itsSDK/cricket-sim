const http = require('http');
const fs = require('fs');
const path = require('path');

const VIDEO_ROOT = 'C:\\Users\\SDK\\Documents\\ScreenConnect\\Files\\Howzat-code\\Example videos';
const PORT = 8770;

const TYPES = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.json': 'application/json',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type, Accept',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
};

const server = http.createServer((req, res) => {
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    res.setHeader(k, v);
  }

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const rawPath = decodeURIComponent((req.url || '/').split('?')[0]);

  if (rawPath === '/list-videos') {
    const out = [];
    const walk = (dir, prefix = '') => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, rel);
        else if (/\.(mp4|mov|webm)$/i.test(e.name)) out.push(rel);
      }
    };
    try {
      walk(VIDEO_ROOT);
    } catch {}
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(out));
  }

  const cleanRel = rawPath.replace(/^\/+(howzat-videos\/|Example videos\/)?/i, '');
  const file = path.resolve(VIDEO_ROOT, cleanRel);
  if (!file.startsWith(path.resolve(VIDEO_ROOT))) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.statusCode = 404;
      return res.end('Not found: ' + cleanRel);
    }

    const ext = path.extname(file).toLowerCase();
    res.setHeader('Content-Type', TYPES[ext] || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');

    if (req.method === 'HEAD') {
      res.setHeader('Content-Length', st.size);
      res.statusCode = 200;
      return res.end();
    }

    const range = req.headers.range;
    if (range) {
      const [s, e] = range.replace(/bytes=/i, '').split('-');
      const start = parseInt(s, 10) || 0;
      const end = e ? parseInt(e, 10) : st.size - 1;
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
      res.setHeader('Content-Length', end - start + 1);
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.statusCode = 200;
      res.setHeader('Content-Length', st.size);
      fs.createReadStream(file).pipe(res);
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Howzat Video Range Server listening on http://localhost:${PORT} -> ${VIDEO_ROOT}`);
});
