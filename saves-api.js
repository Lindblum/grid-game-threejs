import fs from 'node:fs';
import path from 'node:path';

const NAME_RE = /^[\w\-. ]{1,80}\.json$/;

/**
 * Connect-style middleware: a tiny REST API that reads/writes JSON save files in `savesDir`.
 *   GET  /api/saves          -> [{ name, modified, size }] (newest first)
 *   GET  /api/saves/<name>   -> file contents
 *   PUT  /api/saves/<name>   -> write request body (must be valid JSON) to the file
 */
export function createSavesMiddleware(savesDir) {
  return (req, res, next) => {
    if (!req.url.startsWith('/api/saves')) return next();
    const send = (code, body) => {
      res.statusCode = code;
      res.setHeader('Content-Type', 'application/json');
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    try {
      fs.mkdirSync(savesDir, { recursive: true });
      const rest = decodeURIComponent(req.url.replace(/^\/api\/saves\/?/, '').split('?')[0]);

      if (!rest) {
        if (req.method !== 'GET') return send(405, { error: 'Method not allowed' });
        const files = fs
          .readdirSync(savesDir)
          .filter((f) => f.toLowerCase().endsWith('.json'))
          .map((name) => {
            const st = fs.statSync(path.join(savesDir, name));
            return { name, modified: st.mtimeMs, size: st.size };
          })
          .sort((a, b) => b.modified - a.modified);
        return send(200, files);
      }

      if (!NAME_RE.test(rest) || rest.includes('..')) return send(400, { error: 'Invalid file name' });
      const file = path.join(savesDir, rest);

      if (req.method === 'GET') {
        if (!fs.existsSync(file)) return send(404, { error: 'Not found' });
        return send(200, fs.readFileSync(file, 'utf8'));
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            JSON.parse(body);
            fs.writeFileSync(file, body, 'utf8');
            send(200, { ok: true, name: rest });
          } catch {
            send(400, { error: 'Invalid JSON' });
          }
        });
        return;
      }
      send(405, { error: 'Method not allowed' });
    } catch (e) {
      send(500, { error: String(e) });
    }
  };
}
