// Debug → Claude: a dev-server-only bridge that runs Claude Code (the `claude` CLI, signed in
// on this machine) in this repository, for prompts typed (or spoken) into the game's Debug
// dock / XR debug tablet. It is a Vite plugin with `apply: 'serve'`: it only exists while
// `npm run dev` / `npm run dev:xr` runs, never in a build.
//
// Security: every request needs the bridge token (header `x-claude-token`). It is kept in
// .env.local (git-ignored) as CLAUDE_BRIDGE_TOKEN, generated on first start, and the dev server
// prints a link that stores it in a browser. Requests from localhost are NOT trusted on their
// own: an ngrok tunnel (see vite.config.js) delivers internet traffic as localhost.
// Claude may only read and edit files (ALLOWED_TOOLS): no shell commands.
//
// Endpoints (POST, JSON body; responses stream newline-delimited JSON):
//   /__claude/run     { prompt, sessionId? }  starts a run (one at a time; sessionId: carry on
//                                             that conversation) and streams it
//   /__claude/attach  {}                      streams the current / last run from the start
//                                             (the page reloads when Claude edits it)
//   /__claude/stop    {}                      stops the run
//   /__claude/check   {}                      { ok: true }: the token is right
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED_TOOLS = 'Read,Edit,Write,Glob,Grep,TodoWrite';
const SYSTEM_NOTE =
  'You are being driven from the in-game Debug panel of this three.js game (often from a VR headset). ' +
  'Keep replies short and plain-text. You can read and edit files, but not run commands; the dev server ' +
  'hot-reloads the game after your edits.';
const MAX_BODY = 64 * 1024;

/** The bridge token from .env.local, created there if it isn't yet. */
function bridgeToken(root) {
  const file = join(root, '.env.local');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const found = /^CLAUDE_BRIDGE_TOKEN=(.+)$/m.exec(text);
  if (found) return found[1].trim();
  const token = randomBytes(24).toString('base64url');
  appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}CLAUDE_BRIDGE_TOKEN=${token}\n`);
  return token;
}

const sameToken = (a, b) => {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function readJSON(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) reject(new Error('request too large'));
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

export function claudeBridge({ root, base = '/' }) {
  const token = bridgeToken(root);
  // the current / last run: every line it printed (so a reloaded page can catch up), and the
  // responses streaming it live
  let run = null; // { child, lines: [], listeners: Set<res>, done }

  const send = (line) => {
    run.lines.push(line);
    for (const res of run.listeners) res.write(line + '\n');
  };
  const stream = (res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    for (const line of run.lines) res.write(line + '\n');
    if (run.done) return res.end();
    run.listeners.add(res);
    res.on('close', () => run?.listeners.delete(res)); // the page went away: Claude carries on
  };
  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  function start(prompt, sessionId) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--allowedTools', ALLOWED_TOOLS, '--append-system-prompt', SYSTEM_NOTE];
    if (sessionId && /^[\w-]+$/.test(sessionId)) args.push('--resume', sessionId);
    const child = spawn('claude', args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    run = { child, lines: [], listeners: new Set(), done: false };
    send(JSON.stringify({ type: 'prompt', text: prompt }));
    let buffered = '';
    child.stdout.on('data', (d) => {
      buffered += d.toString('utf8');
      let i;
      while ((i = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, i).trim();
        buffered = buffered.slice(i + 1);
        if (line) send(line);
      }
    });
    child.stderr.on('data', (d) => send(JSON.stringify({ type: 'stderr', text: d.toString('utf8') })));
    child.on('error', (e) => send(JSON.stringify({ type: 'stderr', text: `Couldn't start claude: ${e.message}` })));
    child.on('close', (code) => {
      if (buffered.trim()) send(buffered.trim());
      send(JSON.stringify({ type: 'exit', code }));
      run.done = true;
      for (const res of run.listeners) res.end();
      run.listeners.clear();
    });
    child.stdin.end(prompt); // the prompt goes in on stdin (no quoting troubles)
  }

  const handler = async (req, res, next) => {
    const path = (req.url ?? '').split('?')[0];
    const route = path.startsWith(base + '__claude/') ? path.slice(base.length - 1) : path;
    if (!route.startsWith('/__claude/')) return next();
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    if (!sameToken(req.headers['x-claude-token'], token)) return json(res, 401, { error: 'bad or missing bridge token' });
    let body;
    try {
      body = await readJSON(req);
    } catch {
      return json(res, 400, { error: 'bad request body' });
    }
    if (route === '/__claude/check') return json(res, 200, { ok: true });
    if (route === '/__claude/stop') {
      if (run && !run.done) run.child.kill();
      return json(res, 200, { ok: true });
    }
    if (route === '/__claude/attach') {
      if (!run) return json(res, 204, {});
      return stream(res);
    }
    if (route === '/__claude/run') {
      const prompt = String(body.prompt ?? '').trim();
      if (!prompt) return json(res, 400, { error: 'empty prompt' });
      if (run && !run.done) return json(res, 409, { error: 'Claude is still working on the last request' });
      start(prompt, body.sessionId);
      return stream(res);
    }
    return json(res, 404, { error: 'unknown endpoint' });
  };

  return {
    name: 'grid-game-claude-bridge',
    apply: 'serve', // dev server only: never part of a build or `vite preview`
    configureServer(server) {
      server.middlewares.use(handler);
      server.httpServer?.once('listening', () => {
        const addr = server.httpServer.address();
        const port = typeof addr === 'object' && addr ? addr.port : 5173;
        const scheme = server.config.server.https ? 'https' : 'http';
        console.log(`\n  Debug → Claude bridge is on. To allow a browser (e.g. the Quest), open once:\n  ${scheme}://localhost:${port}${base}?claudeToken=${token}\n  (the token is in .env.local; keep it private)\n`);
      });
    },
  };
}
