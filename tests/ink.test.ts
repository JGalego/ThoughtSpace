// Drawing on the paper: gestures, the AI's semantic pen, and ink that becomes meaning.

import { describe, expect, it } from 'vitest';
import { Kernel, datasetFor, networkMetrics, ink } from '../src/kernel';

const stroke = (pts: [number, number][]) => ({ points: pts });

describe('gesture recognition', () => {
  it('tells dots, lines, loops and scribbles apart', () => {
    expect(ink.classify(stroke([[10, 10], [12, 11]]))).toBe('dot');
    expect(ink.classify(stroke(Array.from({ length: 20 }, (_, i) => [i * 10, i * 5 + (i % 2)] as [number, number])))).toBe('line');
    const loop = Array.from({ length: 40 }, (_, i) => [100 + 60 * Math.cos((i / 38) * 2 * Math.PI), 100 + 40 * Math.sin((i / 38) * 2 * Math.PI)] as [number, number]);
    expect(ink.classify(stroke(loop))).toBe('loop');
    expect(ink.encloses(stroke(loop), [100, 100])).toBe(true);
    expect(ink.encloses(stroke(loop), [300, 100])).toBe(false);
    const zig = Array.from({ length: 30 }, (_, i) => [i * 6, (i % 2) * 40] as [number, number]);
    expect(ink.classify(stroke(zig))).toBe('freeform');
  });
});

describe('ink in the kernel', () => {
  const world = () => {
    const k = new Kernel();
    const r = k.dispatch(
      [
        { op: 'create_object', kind: 'dataset', params: { preset: 'and' }, ref: 'd' },
        { op: 'create_object', kind: 'neural_network', ref: 'n', dataset: '$d' },
        { op: 'plot', source: '$n', ref: 'p' },
      ],
      'human',
    );
    return { k, ...(r.refs as { d: string; n: string; p: string }) };
  };

  it('a line drawn across a single neuron plot becomes its boundary', () => {
    const { k, n, p } = world();
    // AND: only (1,1) is positive — draw the line x1 + x2 = 1.5
    const r = k.dispatch([{ op: 'set_boundary', id: p, from: [0.5, 1], to: [1, 0.5] }], 'human');
    expect(r.errors).toEqual([]);
    expect(networkMetrics(k.state(), k.object(n)!)!.accuracy).toBe(1);
    expect(k.object(n)!.provenance.history.at(-1)!.note).toBe('boundary drawn by hand');
    // drawn the "wrong way round", orientation is still chosen to fit the data
    k.dispatch([{ op: 'set_boundary', id: n, from: [1, 0.5], to: [0.5, 1] }], 'human');
    expect(networkMetrics(k.state(), k.object(n)!)!.accuracy).toBe(1);
  });

  it('refuses a drawn boundary for networks whose boundary is a curve', () => {
    const { k, n } = world();
    k.dispatch([{ op: 'set_parameter', id: n, param: 'hidden', value: [2] }], 'human');
    const r = k.dispatch([{ op: 'set_boundary', id: n, from: [0, 1], to: [1, 0] }], 'human');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/hidden layers/);
  });

  it('dots of coloured ink add labelled data', () => {
    const { k, d } = world();
    expect(k.dispatch([{ op: 'invoke', id: d, action: 'add_point', args: { x1: 0.5, x2: 0.5, label: 1 } }], 'human').ok).toBe(true);
    expect(datasetFor(k.state(), world().n)).toBeTruthy();
    expect(k.object(d)!.state.points).toHaveLength(5);
    expect(k.object(d)!.params.preset).toBe('custom');
  });

  it('keeps the human stroke as a sketch that annotates what it was drawn on, and moves with it', () => {
    const { k, n } = world();
    const net = k.object(n)!;
    const r = k.dispatch([{ op: 'draw', strokes: [stroke([[net.visual.x + 20, net.visual.y + 20], [net.visual.x + 40, net.visual.y + 70], [net.visual.x + 90, net.visual.y + 30]])], over: n, color: 'orange', ref: 's' }], 'human');
    expect(r.errors).toEqual([]);
    const s = k.object(r.refs.s)!;
    expect(s.kind).toBe('sketch');
    expect(s.provenance.createdBy).toBe('human');
    expect(Object.values(k.state().relations).some((x) => x.from === s.id && x.to === n && x.type === 'annotates')).toBe(true);
    k.dispatch([{ op: 'move_object', id: n, placement: { at: { x: net.visual.x + 100, y: net.visual.y } } }], 'human');
    expect(k.object(s.id)!.visual.x).toBe(s.visual.x + 100);
  });

  it('the AI draws semantically, never with raw coordinates', () => {
    const { k, n, p } = world();
    expect(k.dispatch([{ op: 'draw', strokes: [stroke([[0, 0], [10, 10]])] }], 'ai').ok).toBe(false);
    const r = k.dispatch([{ op: 'draw', shape: 'circle', target: n, ref: 'c' }, { op: 'draw', shape: 'arrow', target: n, to: p, ref: 'a' }], 'ai');
    expect(r.errors).toEqual([]);
    const c = k.object(r.refs.c)!;
    expect(c.state.color).toBe('violet');
    const N = k.object(n)!.visual;
    // the circle surrounds the network
    expect(c.visual.x).toBeLessThan(N.x);
    expect(c.visual.x + c.visual.w).toBeGreaterThan(N.x + N.w);
    expect(k.object(r.refs.a)!.state.strokes).toHaveLength(2); // body + head
  });
});
