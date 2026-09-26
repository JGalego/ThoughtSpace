// Forms the protocol accepts because live models write them — each one unambiguous.

import { describe, expect, it } from 'vitest';
import { Kernel } from '../src/kernel';

describe('protocol ergonomics learned from live models', () => {
  it('accepts ref names without "$" and keeps refs across batches of one turn', () => {
    const k = new Kernel();
    const a = k.dispatch([{ op: 'create_object', kind: 'dataset', ref: 'xor_data' }], 'ai');
    const b = k.dispatch([{ op: 'create_object', kind: 'neural_network', ref: 'net', dataset: 'xor_data' }], 'ai', { refs: a.refs });
    expect(b.errors).toEqual([]);
    const c = k.dispatch([{ op: 'execute', id: '$net', ref: 'run' }, { op: 'plot', source: '$run' }], 'ai', { refs: { ...a.refs, ...b.refs } });
    expect(c.errors).toEqual([]);
    expect(k.object(c.refs.run)!.kind).toBe('simulation');
  });

  it('understands placement aliases, strings and extra keys', () => {
    const k = new Kernel();
    const r = k.dispatch(
      [
        { op: 'create_object', kind: 'dataset', ref: 'd' },
        { op: 'create_object', kind: 'text', placement: { right_of: '$d' } },
        { op: 'create_object', kind: 'text', placement: 'below $d' },
        { op: 'create_object', kind: 'text', placement: { area: 'top', beside: '$d' } },
      ],
      'ai',
    );
    expect(r.errors).toEqual([]);
    expect(k.dispatch([{ op: 'create_object', kind: 'text', placement: { somewhere: 'x' } }], 'ai').ok).toBe(false);
  });

  it('maps natural metric and comparison names in experiments', () => {
    const k = new Kernel();
    const r = k.dispatch(
      [
        { op: 'create_object', kind: 'dataset', ref: 'd' },
        { op: 'create_object', kind: 'neural_network', ref: 'n', dataset: '$d' },
        { op: 'experiment', target: '$n', ref: 'e', seeds: [1, 2], variable: { param: 'hidden', values: [[], [2]] }, hypothesis: { text: 'x', expect: [{ value: [], metric: 'accuracy', op: 'lt', threshold: '1' }] } },
        { op: 'claim', text: 'one neuron fails', about: ['$n'], ref: 'c' },
        { op: 'verify_claim', claim: '$c', evidence: ['$e'] },
      ],
      'ai',
    );
    expect(r.errors).toEqual([]);
    expect(k.object(r.refs.c)!.state.status).toBe('supported');
  });
});

describe('experiments as evidence', () => {
  const setup = () => {
    const k = new Kernel();
    const r = k.dispatch(
      [
        { op: 'create_object', kind: 'dataset', ref: 'd' },
        { op: 'create_object', kind: 'neural_network', ref: 'n', dataset: '$d' },
        { op: 'claim', text: 'a hidden layer beats none on XOR', about: ['$n'], ref: 'c' },
      ],
      'ai',
    );
    return { k, refs: r.refs };
  };

  it('an experiment without expectations is inconclusive and cannot verify a claim', () => {
    const { k, refs } = setup();
    const e = k.dispatch([{ op: 'experiment', target: refs.n, ref: 'e', seeds: [1, 2], variable: { param: 'hidden', values: [[], [2]] }, hypothesis: { text: 'hidden helps' } }], 'ai');
    expect(k.object(e.refs.e)!.state.supported).toBeNull();
    const v = k.dispatch([{ op: 'verify_claim', claim: refs.c, evidence: e.refs.e }], 'ai');
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toMatch(/inconclusive/);
    expect(k.object(refs.c)!.state.status).toBe('unverified');
  });

  it('relative expectations compare one value against another', () => {
    const { k, refs } = setup();
    const r = k.dispatch(
      [
        { op: 'experiment', target: refs.n, ref: 'e', seeds: [1, 2, 3, 4], variable: { param: 'hidden', values: [[], [2]] }, hypothesis: { text: 'hidden helps', expect: [{ value: [2], metric: 'accuracy', op: '>', than: [] }] } },
        { op: 'verify_claim', claim: refs.c, evidence: '$e' },
      ],
      'ai',
    );
    expect(r.errors).toEqual([]);
    expect(k.object(refs.c)!.state.status).toBe('supported');
  });
});

describe('more live-model forms', () => {
  it('treats unresolvable placement as a hint, accepts $ref: and reversed data edges', () => {
    const k = new Kernel();
    const r = k.dispatch(
      [
        { op: 'create_object', kind: 'dataset', ref: 'xor', placement: 'center' },
        { op: 'create_object', kind: 'neural_network', ref: 'n', placement: { beside: '$ref:xor' } },
        { op: 'connect', from: '$n', to: '$xor', relation: 'feeds_into' },
      ],
      'ai',
    );
    expect(r.errors).toEqual([]);
    const rel = Object.values(k.state().relations).find((x) => x.type === 'feeds_into')!;
    expect([rel.from, rel.to]).toEqual([r.refs.xor, r.refs.n]);
  });

  it('abstracting grouped objects takes them out of the group', () => {
    const k = new Kernel();
    const r = k.dispatch(
      [
        { op: 'create_object', kind: 'dataset', ref: 'd' },
        { op: 'create_object', kind: 'neural_network', ref: 'n', dataset: '$d' },
        { op: 'group', ids: ['$d', '$n'], label: 'G', ref: 'g' },
        { op: 'abstract', ids: ['$d', '$n'], name: 'Thing', ref: 'gl' },
      ],
      'ai',
    );
    expect(r.errors).toEqual([]);
    expect(k.object(r.refs.n)!.parent).toBe(r.refs.gl);
    expect(k.object(r.refs.g)!.state.members).toEqual([]);
  });
});

describe('layout', () => {
  it('never overlaps AI-placed objects, even in a crowded neighbourhood', () => {
    const k = new Kernel();
    const ops: any[] = [{ op: 'create_object', kind: 'dataset', ref: 'd' }, { op: 'create_object', kind: 'neural_network', ref: 'n', dataset: '$d' }];
    for (let i = 0; i < 14; i++) ops.push({ op: 'annotate', target: '$n', text: 'note '.repeat(40 + i * 5) });
    ops.push({ op: 'experiment', target: '$n', seeds: [1], variable: { param: 'hidden', values: [[], [2]] }, hypothesis: { text: 'h' } });
    ops.push({ op: 'compare', a: '$d', b: '$n' });
    expect(k.dispatch(ops, 'ai').errors).toEqual([]);
    const vis = Object.values(k.state().objects).filter((o) => !o.visual.hidden);
    for (const a of vis)
      for (const b of vis)
        if (a.id < b.id) {
          const A = a.visual, B = b.visual;
          expect(A.x < B.x + B.w && A.x + A.w > B.x && A.y < B.y + B.h && A.y + A.h > B.y, `${a.id} overlaps ${b.id}`).toBe(false);
        }
  });
});

describe('abstraction and shared data', () => {
  it('keeps a dataset used by other networks outside the glyph, as its data input', () => {
    const k = new Kernel();
    const r = k.dispatch(
      [
        { op: 'create_object', kind: 'dataset', ref: 'd' },
        { op: 'create_object', kind: 'neural_network', ref: 'a', dataset: '$d' },
        { op: 'create_object', kind: 'neural_network', ref: 'b', dataset: '$d', params: { hidden: [2] } },
        { op: 'abstract', ids: ['$d', '$b'], name: 'Solver', ref: 'g' },
      ],
      'ai',
    );
    expect(r.errors).toEqual([]);
    const g = k.object(r.refs.g)!;
    expect(g.state.members).toEqual([r.refs.b]);
    expect(g.state.dataInput).toBe(true);
    expect(k.object(r.refs.d)!.visual.hidden).toBeFalsy();
  });
});

describe('expanding a glyph', () => {
  it('lays the construction out without covering anything, the glyph card included', () => {
    const k = new Kernel();
    const r = k.dispatch(
      [
        { op: 'create_object', kind: 'dataset', ref: 'd' },
        { op: 'create_object', kind: 'neural_network', ref: 'n', dataset: '$d', params: { hidden: [2] } },
        { op: 'plot', source: '$n', ref: 'p' },
        { op: 'annotate', target: '$n', text: 'a note in the neighbourhood' },
        { op: 'abstract', ids: ['$n', '$p'], name: 'G', ref: 'g' },
        { op: 'expand', id: '$g' },
      ],
      'ai',
    );
    expect(r.errors).toEqual([]);
    const vis = Object.values(k.state().objects).filter((o) => !o.visual.hidden);
    for (const a of vis)
      for (const b of vis)
        if (a.id < b.id) {
          const A = a.visual, B = b.visual;
          expect(A.x < B.x + B.w && A.x + A.w > B.x && A.y < B.y + B.h && A.y + A.h > B.y, `${a.id} overlaps ${b.id}`).toBe(false);
        }
  });
});
