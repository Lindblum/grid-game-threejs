import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath } from 'node:url';
import { createSavesMiddleware } from './saves-api.js';
import { claudeBridge } from './claude-bridge.js';

const SAVES_DIR = fileURLToPath(new URL('./saves', import.meta.url));
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const BASE = '/grid-game-threejs/';

/** Serves /api/saves (see saves-api.js) from both `vite` and `vite preview`. */
function savesApi() {
  const handler = createSavesMiddleware(SAVES_DIR);
  return {
    name: 'grid-game-saves-api',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

// Files the dev server must never serve (it serves the project folder): Vite's own defaults (.env files with the secrets, certificates, git) plus the dev-server code.
const SERVER_ONLY = ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', 'vite.config.*', 'claude-bridge.js', 'saves-api.js'];

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ROOT, '');
  return {
    plugins: [react(), savesApi(), claudeBridge({ root: ROOT, base: BASE }), ...(mode === 'xr' ? [basicSsl()] : [])],
    base: BASE,
    server: {
      host: mode === 'xr' ? true : 'localhost', port: 5172, allowedHosts: env.NGROK_HOST ? [env.NGROK_HOST] : [],
      fs: { deny: SERVER_ONLY },
    },
    preview: {
      host: mode === 'xr' ? true : 'localhost', port: 5272, allowedHosts: env.NGROK_HOST ? [env.NGROK_HOST] : [],
    },
  };
});
