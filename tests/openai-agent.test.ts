// The OpenAI-compatible participant (Chat Completions dialect) against a stubbed server:
// base URL respected, tool calls reach the kernel, <think> stripped, and the
// max_completion_tokens → max_tokens fallback for servers that only know the old name,
// and streaming (slow local servers time out non-streaming requests).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Kernel } from '../src/kernel';
import { openaiAgent } from '../src/agent/openai';
import type { AgentHost } from '../src/agent/host';

const completion = (message: Record<string, unknown>, finish = 'stop') => ({
  id: 'c', object: 'chat.completion', created: 0, model: 'm',
  choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content: null, ...message } }],
});

/** a completion as the server-sent-event stream a compatible server sends */
function sse(c: ReturnType<typeof completion>): Response {
  const ch = c.choices[0];
  const m = ch.message as any;
  const delta: any = { role: 'assistant' };
  if (m.content) delta.content = m.content;
  if (m.tool_calls) delta.tool_calls = m.tool_calls.map((t: any, index: number) => ({ index, ...t }));
  const chunk = (d: any, finish: string | null) => `data: ${JSON.stringify({ id: c.id, object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`;
  const body = chunk(delta, null) + chunk({}, ch.finish_reason) + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('OpenAI-compatible agent (chat dialect)', () => {
  it('drives the kernel through a compatible server', async () => {
    const calls: { url: string; body: any }[] = [];
    let first = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        calls.push({ url: String(url), body });
        // an older server that rejects the modern parameter name
        if (first && 'max_completion_tokens' in body) {
          first = false;
          return new Response(JSON.stringify({ error: { message: "Unrecognized request argument supplied: max_completion_tokens" } }), { status: 400, headers: { 'content-type': 'application/json' } });
        }
        const reply =
          calls.filter((c) => !('max_completion_tokens' in c.body)).length === 1
            ? completion({ tool_calls: [{ id: 't1', type: 'function', function: { name: 'apply_operations', arguments: JSON.stringify({ operations: [{ op: 'create_object', kind: 'dataset', ref: 'd' }, { op: 'create_object', kind: 'neural_network', dataset: 'd' }] }) } }] }, 'tool_calls')
            : completion({ content: '<think>plan…</think>Built XOR data and a neuron.' });
        expect(body.stream).toBe(true);
        return sse(reply);
      }),
    );
    const kernel = new Kernel();
    const said: string[] = [];
    const host: AgentHost = { kernel, selection: () => [], apply: (ops, _s, refs) => kernel.dispatch(ops, 'ai', { refs }), highlight: () => {}, focus: () => {}, say: (t) => said.push(t), status: () => {} };

    await openaiAgent({ mode: 'key', baseURL: 'http://localhost:11434/v1', model: 'qwen3:4b', api: 'chat', label: 'Ollama' }).run('build it', host, []);

    expect(calls[0].url).toBe('http://localhost:11434/v1/chat/completions');
    expect(calls[1].body.max_tokens).toBe(8000);
    expect(calls.at(-1)!.body.max_tokens).toBe(8000); // remembered
    expect(calls[1].body.tools.map((t: any) => t.function.name)).toEqual(['apply_operations', 'inspect', 'highlight']);
    expect(Object.values(kernel.state().objects).map((o) => o.kind).sort()).toEqual(['dataset', 'neural_network']);
    expect(said).toEqual(['Built XOR data and a neuron.']);
  });
});
