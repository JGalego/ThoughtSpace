// The Claude participant, exercised against a stubbed Messages API: tool calls become
// validated kernel operations, and validation errors go back to the model as tool errors.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Kernel } from '../src/kernel';
import { claudeAgent } from '../src/agent/claude';
import type { AgentHost } from '../src/agent/host';

function message(content: unknown[], stop_reason: string) {
  return {
    id: `msg_${Math.random()}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Claude agent loop', () => {
  it('applies tool calls through the kernel and reports validation errors back', async () => {
    const replies = [
      message([{ type: 'tool_use', id: 'tu_1', name: 'apply_operations', input: { operations: [{ op: 'create_object', kind: 'neural_network', params: { activation: 'softmax' } }] } }], 'tool_use'),
      message(
        [
          {
            type: 'tool_use',
            id: 'tu_2',
            name: 'apply_operations',
            input: {
              operations: [
                { op: 'create_object', kind: 'dataset', ref: 'd' },
                { op: 'create_object', kind: 'neural_network', ref: 'n', dataset: '$d', placement: { beside: '$d' } },
                { op: 'execute', id: '$n' },
              ],
            },
          },
          { type: 'tool_use', id: 'tu_3', name: 'highlight', input: { targets: ['net_2#neuron:1:0'] } },
        ],
        'tool_use',
      ),
      message([{ type: 'text', text: 'Built and trained a single neuron.' }], 'end_turn'),
    ];
    const bodies: any[] = [];
    vi.stubGlobal('location', { origin: 'http://localhost' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify(replies.shift()), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );

    const kernel = new Kernel();
    const said: string[] = [];
    const highlights: string[][] = [];
    const host: AgentHost = {
      kernel,
      selection: () => [],
      apply: (ops) => kernel.dispatch(ops, 'ai'),
      highlight: (t) => highlights.push(t),
      focus: () => {},
      say: (t) => said.push(t),
      status: () => {},
    };
    await claudeAgent({ mode: 'key', apiKey: 'test', model: 'claude-opus-5' }).run('build a neuron', host, []);

    // first batch was rejected atomically and the error was returned as a tool error
    const second = bodies[1];
    const toolResult = second.messages.at(-1).content[0];
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toMatch(/activation/);

    // second batch applied: objects are AI-authored and the network was trained deterministically
    const objs = Object.values(kernel.state().objects);
    expect(objs.map((o) => o.kind).sort()).toEqual(['dataset', 'neural_network', 'simulation']);
    expect(objs.every((o) => o.provenance.createdBy === 'ai')).toBe(true);
    const third = bodies[2];
    expect(JSON.stringify(third.messages.at(-1).content)).toMatch(/Trained/);
    expect(highlights).toEqual([['net_2#neuron:1:0']]);
    expect(said).toEqual(['Built and trained a single neuron.']);

    // requests carry the semantic workspace, the protocol and adaptive thinking
    expect(bodies[0].model).toBe('claude-opus-5');
    expect(bodies[0].thinking).toEqual({ type: 'adaptive' });
    expect(bodies[0].system[0].text).toMatch(/apply_operations|OPERATIONS/);
    expect(bodies[0].messages[0].content).toMatch(/Workspace:/);
  });
});
