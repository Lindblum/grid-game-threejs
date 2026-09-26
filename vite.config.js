import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath } from 'node:url';
import { createSavesMiddleware } from './saves-api.js';

const SAVES_DIR = fileURLToPath(new URL('./saves', import.meta.url));

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

// `npm run dev`    -> http://localhost:5173 (desktop browser)
// `npm run dev:xr` -> https://<your-LAN-IP>:5173 (for Quest headset; WebXR needs HTTPS)
export default defineConfig(({ mode }) => ({
  plugins: [react(), savesApi(), ...(mode === 'xr' ? [basicSsl()] : [])],
  server: { host: mode === 'xr' ? true : 'localhost', port: 5173, allowedHosts: ['debrah-impartable-nonubiquitously.ngrok-free.dev'] },
  preview: { host: mode === 'xr' ? true : 'localhost', port: 4173 }
}));
