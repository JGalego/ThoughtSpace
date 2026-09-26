import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// In development, provider API keys stay on the dev server: the browser talks to
// /api/anthropic or /api/openai and the proxy attaches the key. Without any key the app
// runs its deterministic offline planner.
export default defineConfig(({ mode }) => {
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), '') };
  const anthropic = env.ANTHROPIC_API_KEY;
  const openai = env.OPENAI_API_KEY;
  // any OpenAI-compatible server (Groq, Ollama, OpenRouter, …), e.g.
  //   OPENAI_COMPAT_BASE_URL=https://api.groq.com/openai/v1 OPENAI_COMPAT_API_KEY=gsk_…
  const compatBase = env.OPENAI_COMPAT_BASE_URL?.replace(/\/+$/, '');
  const compatKey = env.OPENAI_COMPAT_API_KEY;
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
  if (compatBase) {
    const u = new URL(compatBase);
    proxy['/api/compat'] = {
      target: u.origin,
      changeOrigin: true,
      // /api/compat/v1/chat/completions → <base path>/chat/completions
      rewrite: (p: string) => p.replace(/^\/api\/compat\/v1/, u.pathname.replace(/\/$/, '')),
      ...(compatKey ? { headers: { authorization: `Bearer ${compatKey}` } } : {}),
    };
  }
  return {
    plugins: [react()],
    define: {
      __PROXIES__: JSON.stringify({ anthropic: !!anthropic, openai: !!openai, compatible: !!compatBase }),
      __COMPAT_BASE__: JSON.stringify(compatBase ?? ''),
      __COMPAT_MODEL__: JSON.stringify(env.OPENAI_COMPAT_MODEL ?? ''),
    },
    build: { chunkSizeWarningLimit: 1500 },
    server: { proxy },
    test: { environment: 'node' },
  } as any;
});
