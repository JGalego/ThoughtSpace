import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// In development the Anthropic API key stays on the dev server: the browser talks to
// /api/anthropic and the proxy attaches the key. Without a key the app runs its
// deterministic offline planner.
export default defineConfig(({ mode }) => {
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), '') };
  const key = env.ANTHROPIC_API_KEY;
  return {
    plugins: [react()],
    define: { __PROXY_HAS_KEY__: JSON.stringify(!!key) },
    build: { chunkSizeWarningLimit: 1500 },
    server: {
      proxy: key
        ? {
            '/api/anthropic': {
              target: 'https://api.anthropic.com',
              changeOrigin: true,
              rewrite: (p: string) => p.replace(/^\/api\/anthropic/, ''),
              headers: { 'x-api-key': key },
            },
          }
        : undefined,
    },
    test: { environment: 'node' },
  } as any;
});
