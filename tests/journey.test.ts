// The canonical first-run journey, driven through the offline planner exactly as the UI does.

import { describe, expect, it } from 'vitest';
import { Kernel, networkMetrics, type ObjectId } from '../src/kernel';
import { localAgent } from '../src/agent/local';
import type { AgentHost } from '../src/agent/host';

function harness() {
  const kernel = new Kernel();
  let selection: ObjectId[] = [];
  const said: string[] = [];
  const highlights: string[][] = [];
  const host: AgentHost = {
    kernel,
    selection: () => selection,
    apply: (ops, summary) => kernel.dispatch(ops, 'ai', { summary }),
    highlight: (t) => highlights.push(t),
    focus: () => {},
    say: (t) => said.push(t),
    status: () => {},
  };
  const ask = async (text: string, sel: ObjectId[] = selection) => {
    selection = sel;
    await localAgent.run(text, host, []);
    return said[said.length - 1];
  };
  const find = (pred: (o: any) => boolean) => Object.values(kernel.state().objects).find(pred)!;
  return { kernel, ask, said, highlights, find, select: (s: ObjectId[]) => (selection = s) };
}

describe('XOR journey through the planner', () => {
  it('construct → manipulate → why → smallest change → compare → glyph', async () => {
    const h = harness();
    await h.ask("Let's understand why XOR requires a hidden layer.");
    const net = h.find((o) => o.kind === 'neural_network');
    expect(net.params.hidden).toEqual([]);
    expect(h.find((o) => o.kind === 'graph').params.mode).toBe('decision_boundary');
    expect(h.find((o) => o.kind === 'claim').state.status).toBe('unverified');

    // direct manipulation by the human
    expect(h.kernel.dispatch([{ op: 'invoke', id: net.id, action: 'set_weight', args: { layer: 0, to: 0, from: 0, value: 3 } }], 'human').ok).toBe(true);
    // training by the human
    expect(h.kernel.dispatch([{ op: 'execute', id: net.id }], 'human').ok).toBe(true);

    const why = await h.ask("Why doesn't this one work?", [net.id]);
    expect(why).toMatch(/straight line/);
    expect(h.highlights.at(-1)!.some((t) => t.includes('#neuron:1:0'))).toBe(true);
    expect(h.find((o) => o.kind === 'text' && o.label === 'Why it fails')).toBeTruthy();

    const fix = await h.ask('Show me the smallest change that makes it work.', [net.id]);
    expect(fix).toMatch(/hidden layer of 2 units/);
    const variant = h.find((o) => o.kind === 'neural_network' && o.id !== net.id);
    expect(variant.params.hidden).toEqual([2]);
    expect(networkMetrics(h.kernel.state(), variant)!.accuracy).toBe(1);
    expect(h.find((o) => o.kind === 'claim').state.status).toBe('supported');

    await h.ask('Compare them', [net.id, variant.id]);
    expect(h.find((o) => o.kind === 'comparison')).toBeTruthy();

    const g = await h.ask('Turn this into a reusable XOR network glyph.', [variant.id]);
    expect(g).toMatch(/XORNetwork/);
    const glyph = h.find((o) => o.kind === 'glyph');
    expect(glyph.label).toBe('XORNetwork');
    expect(glyph.state.members).toContain(variant.id);
    expect(Object.keys(h.kernel.state().glyphs)).toHaveLength(1);
    // the XOR data stayed outside (the original network uses it too), so the glyph has a data input
    expect(glyph.state.dataInput).toBe(true);
    // a fresh instance from the library is wired to the same data and works
    const inst = h.kernel.dispatch([{ op: 'instantiate_glyph', definition: 'XORNetwork', ref: 'g2' }], 'human');
    const innerNet = h.kernel.object(inst.refs.g2)!.state.output;
    expect(networkMetrics(h.kernel.state(), h.kernel.object(innerNet)!)!.accuracy).toBe(1);
  });

  it('what-if branches and architecture edits', async () => {
    const h = harness();
    await h.ask("Let's understand why XOR requires a hidden layer.");
    const net = h.find((o) => o.kind === 'neural_network');
    await h.ask('add another hidden layer with 3 units', [net.id]);
    expect(h.kernel.object(net.id)!.params.hidden).toEqual([3]);
    await h.ask('train it', [net.id]);
    await h.ask('what if we used relu?', [net.id]);
    const v = h.find((o) => o.kind === 'neural_network' && o.id !== net.id);
    expect(v.params.activation).toBe('relu');
    expect(v.provenance.assumption).toBe('relu activation');
  });
});
