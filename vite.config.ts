import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// In development, provider API keys stay on the dev server: the browser talks to
// /api/anthropic or /api/openai and the proxy attaches the key. Without any key the app
// runs its deterministic offline planner.
export default defineConfig(({ mode }) => {
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), '') };
  const anthropic = env.ANTHROPIC_API_KEY;
  const openai = env.OPENAI_API_KEY;
  const proxy: Record<string, unknown> = {};
  if (anthropic)
    proxy['/api/anthropic'] = {
      target: 'https://api.anthropic.com',
      changeOrigin: true,
      rewrite: (p: string) => p.replace(/^\/api\/anthropic/, ''),
      headers: { 'x-api-key': anthropic },
    };
  if (openai)
    proxy['/api/openai'] = {
      target: 'https://api.openai.com',
      changeOrigin: true,
      rewrite: (p: string) => p.replace(/^\/api\/openai/, ''),
      headers: { authorization: `Bearer ${openai}` },
    };
  return {
    plugins: [react()],
    define: { __PROXIES__: JSON.stringify({ anthropic: !!anthropic, openai: !!openai }) },
    build: { chunkSizeWarningLimit: 1500 },
    server: { proxy },
    test: { environment: 'node' },
  } as any;
});
