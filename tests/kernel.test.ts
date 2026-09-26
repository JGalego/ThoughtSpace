import { describe, expect, it } from 'vitest';
import { Kernel, datasetFor, networkMetrics, semanticView, suggestions, emptyWorkspace } from '../src/kernel';
import { replay } from '../src/kernel/reduce';

function xorWorld(k: Kernel, hidden: number[] = []) {
  const r = k.dispatch(
    [
      { op: 'create_object', kind: 'dataset', params: { preset: 'xor' }, ref: 'data' },
      { op: 'create_object', kind: 'neural_network', params: { hidden }, ref: 'net', placement: { beside: '$data' }, dataset: '$data' },
      { op: 'plot', source: '$net', ref: 'plot' },
    ],
    'ai',
  );
  expect(r.errors).toEqual([]);
  return r.refs as { data: string; net: string; plot: string };
}

describe('operations are validated', () => {
  it('rejects unknown ops, kinds, params and bad values atomically', () => {
    const k = new Kernel();
    expect(k.dispatch([{ op: 'teleport' }], 'ai').ok).toBe(false);
    expect(k.dispatch([{ op: 'create_object', kind: 'spaceship' }], 'ai').ok).toBe(false);
    const bad = k.dispatch(
      [
        { op: 'create_object', kind: 'neural_network', ref: 'n' },
        { op: 'set_parameter', id: '$n', param: 'activation', value: 'softmax' },
      ],
      'ai',
    );
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]).toMatch(/activation/);
    // atomic: the first op did not survive
    expect(Object.keys(k.state().objects)).toHaveLength(0);
  });

  it('keeps the AI from using raw coordinates', () => {
    const k = new Kernel();
    const r = k.dispatch([{ op: 'create_object', kind: 'text', placement: { at: { x: 1, y: 2 } } }], 'ai');
    expect(r.ok).toBe(false);
    expect(k.dispatch([{ op: 'create_object', kind: 'text', placement: { at: { x: 1, y: 2 } } }], 'human').ok).toBe(true);
  });

  it('claims cannot be marked supported without evidence', () => {
    const k = new Kernel();
    const { net } = xorWorld(k);
    const c = k.dispatch([{ op: 'claim', text: 'one neuron cannot do XOR', about: [net], ref: 'c' }], 'ai');
    expect(c.ok).toBe(true);
    const r = k.dispatch([{ op: 'modify_object', id: c.refs.c, state: { status: 'supported' } }], 'ai');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/verify_claim/);
  });
});

describe('the XOR journey', () => {
  it('a single neuron cannot fit XOR; the smallest working change is a hidden layer of 2', () => {
    const k = new Kernel();
    const { net } = xorWorld(k);
    const t = k.dispatch([{ op: 'execute', id: net }], 'human');
    expect(t.ok).toBe(true);
    const m = networkMetrics(k.state(), k.object(net)!)!;
    expect(m.accuracy).toBeLessThan(1);

    const e = k.dispatch(
      [
        {
          op: 'experiment',
          target: net,
          ref: 'e',
          variable: { param: 'hidden', values: [[], [1], [2]] },
          seeds: [1, 2, 3, 4],
          hypothesis: {
            text: 'Without a hidden layer XOR is never solved',
            expect: [
              { value: [], metric: 'success_rate', op: '==', threshold: 0 },
              { value: [2], metric: 'success_rate', op: '>', threshold: 0 },
            ],
          },
        },
      ],
      'ai',
    );
    expect(e.errors).toEqual([]);
    const exp = k.object(e.refs.e)!;
    expect(exp.state.supported).toBe(true);

    // reproducibility
    const rep = k.dispatch([{ op: 'reproduce', id: e.refs.e }], 'human');
    expect(rep.ok).toBe(true);
    expect(k.object(e.refs.e)!.state.reproductions[0].match).toBe(true);

    // claim verified only through evidence
    const c = k.dispatch([{ op: 'claim', text: 'XOR needs a hidden layer', about: [net], ref: 'c' }, { op: 'verify_claim', claim: '$c', evidence: e.refs.e }], 'ai');
    expect(k.object(c.refs.c)!.state.status).toBe('supported');

    // branch: variant with a hidden layer, trained
    const b = k.dispatch([{ op: 'branch', ids: [net], assumption: 'add a hidden layer of 2 units', changes: [{ id: net, param: 'hidden', value: [2] }, { id: net, param: 'seed', value: 1 }], execute: true, ref: 'v' }], 'ai');
    expect(b.errors).toEqual([]);
    const v = k.object(b.refs.v)!;
    expect(v.params.hidden).toEqual([2]);
    expect(v.provenance.assumption).toMatch(/hidden layer/);
    expect(datasetFor(k.state(), v.id)?.id).toBe(datasetFor(k.state(), net)?.id);
    expect(networkMetrics(k.state(), v)!.accuracy).toBe(1);
    expect(Object.values(k.state().relations).some((r) => r.type === 'branched_from' && r.from === v.id && r.to === net)).toBe(true);
  });
});

describe('history', () => {
  it('replays deterministically and supports undo/redo', () => {
    const k = new Kernel();
    const { net } = xorWorld(k);
    k.dispatch([{ op: 'execute', id: net }], 'human');
    const before = k.state();
    const events = k.lineage().flatMap((l) => l.tx.events);
    expect(replay(emptyWorkspace(), events)).toEqual(before);

    k.undo();
    expect(k.object(net)!.state.trainedBy).toBeNull();
    k.redo();
    expect(k.object(net)!.state.trainedBy).toBeTruthy();
  });

  it('coalesces a weight drag into one transaction', () => {
    const k = new Kernel();
    const { net } = xorWorld(k);
    const n0 = k.branch.transactions.length;
    for (const v of [0.1, 0.2, 0.3, 0.4])
      k.dispatch([{ op: 'invoke', id: net, action: 'set_weight', args: { layer: 0, to: 0, from: 0, value: v } }], 'human', { coalesceKey: 'drag' });
    expect(k.branch.transactions.length).toBe(n0 + 1);
    expect(k.object(net)!.state.weights[0][0][0]).toBe(0.4);
    k.undo();
    expect(k.object(net)!.state.weights[0][0][0]).not.toBe(0.4);
  });

  it('persists and reloads', () => {
    const k = new Kernel();
    xorWorld(k);
    const k2 = new Kernel();
    expect(k2.load(k.serialize())).toBe(true);
    expect(k2.state()).toEqual(k.state());
  });
});

describe('workspace branches', () => {
  it('forks keep an explicit parent and can be diffed', () => {
    const k = new Kernel();
    const { net } = xorWorld(k);
    const main = k.current;
    const b = k.fork('relu world', 'what if the hidden units were ReLU?', 'human');
    k.dispatch([{ op: 'set_parameter', id: net, param: 'activation', value: 'relu' }], 'human');
    expect(k.branches[b].parent).toBe(main);
    const d = k.diffBranches(main, b);
    expect(d.common).toBe(main);
    expect(d.changed.find((c) => c.id === net)!.params).toEqual([{ name: 'activation', a: 'tanh', b: 'relu' }]);
    k.switchBranch(main);
    expect(k.object(net)!.params.activation).toBe('tanh');
  });

  it('a child branch survives its parent rewriting history', () => {
    const k = new Kernel();
    const { net } = xorWorld(k);
    k.dispatch([{ op: 'set_parameter', id: net, param: 'seed', value: 7 }], 'human');
    const child = k.fork('child', undefined, 'human');
    const childState = k.state();
    k.switchBranch('main');
    k.undo();
    k.dispatch([{ op: 'set_parameter', id: net, param: 'seed', value: 9 }], 'human');
    k.switchBranch(child);
    expect(k.state()).toEqual(childState);
  });
});

describe('glyphs', () => {
  it('abstract keeps the construction, exposes params, expands and re-instantiates', () => {
    const k = new Kernel();
    const { data, net, plot } = xorWorld(k, [2]);
    const r = k.dispatch([{ op: 'abstract', ids: [data, net, plot], name: 'XORNetwork', ref: 'g' }], 'ai');
    expect(r.errors).toEqual([]);
    const g = k.object(r.refs.g)!;
    expect(g.state.members).toEqual([data, net, plot]);
    expect(k.object(net)!.visual.hidden).toBe(true);

    // exposed param writes through
    expect(k.dispatch([{ op: 'set_parameter', id: g.id, param: 'activation', value: 'relu' }], 'ai').ok).toBe(true);
    expect(k.object(net)!.params.activation).toBe('relu');

    // expand shows the construction again
    k.dispatch([{ op: 'expand', id: g.id }], 'human');
    expect(k.object(net)!.visual.hidden).toBe(false);

    // reuse
    const inst = k.dispatch([{ op: 'instantiate_glyph', definition: 'XORNetwork', ref: 'g2' }], 'human');
    expect(inst.errors).toEqual([]);
    const g2 = k.object(inst.refs.g2)!;
    expect(g2.state.members).toHaveLength(3);
    const innerNet = g2.state.output;
    expect(k.object(innerNet)!.kind).toBe('neural_network');
    expect(datasetFor(k.state(), innerNet)).toBeTruthy();
    // training the instance trains its inner network
    expect(k.dispatch([{ op: 'execute', id: g2.id }], 'human').ok).toBe(true);
  });
});

describe('semantic view & suggestions', () => {
  it('describes the workspace semantically and notices affordances', () => {
    const k = new Kernel();
    const { net } = xorWorld(k);
    const v = semanticView(k.state(), [net]) as any;
    expect(v.objects.find((o: any) => o.id === net).architecture).toBe('2→1');
    expect(v.relations.some((r: any[]) => r[1] === 'feeds_into')).toBe(true);
    k.dispatch([{ op: 'execute', id: net }], 'human');
    const s = suggestions(k.state());
    expect(s.some((x) => x.key.startsWith('why:'))).toBe(true);
  });
});
