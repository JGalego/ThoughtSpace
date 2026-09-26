// Open lessons: variables, formulas, systems and random trials compose into working models
// of any subject, and the rest of the medium (plots, experiments, claims, branches,
// glyphs) works on them. Each block below is a construction a teacher or AI might build.

import { describe, expect, it } from 'vitest';
import { Kernel, measure, scalarOf, systemOf, trialsOf, sweep, semanticView } from '../src/kernel';

const obj = (k: Kernel, id: string) => k.object(id)!;

describe('physics: projectile motion', () => {
  const build = () => {
    const k = new Kernel();
    const r = k.dispatch(
      [
        { op: 'create_object', kind: 'variable', name: 'theta', value: 30, min: 0, max: 90, unit: '°', label: 'Launch angle', ref: 'th' },
        { op: 'create_object', kind: 'variable', name: 'v0', value: 25, min: 0, max: 50, unit: 'm/s', ref: 'v' },
        { op: 'create_object', kind: 'variable', name: 'g', value: 9.81, min: 1, max: 25, ref: 'g' },
        { op: 'create_object', kind: 'variable', name: 'k', value: 0, min: 0, max: 0.1, label: 'Air drag', ref: 'k' },
        { op: 'create_object', kind: 'formula', name: 'range_vacuum', expr: 'v0^2 * sin(2*rad(theta)) / g', unit: 'm', ref: 'rv' },
        {
          op: 'create_object',
          kind: 'system',
          name: 'ball',
          ref: 'sys',
          vars: [
            { name: 'x', init: '0', rate: 'vx' },
            { name: 'y', init: '0', rate: 'vy' },
            { name: 'vx', init: 'v0*cos(rad(theta))', rate: '-k*speed*vx' },
            { name: 'vy', init: 'v0*sin(rad(theta))', rate: '-g - k*speed*vy' },
          ],
          helpers: [{ name: 'speed', expr: 'hypot(vx, vy)' }],
          stop: 'y < 0',
          t_max: 20,
          dt: 0.005,
        },
        { op: 'plot', source: '$sys', x: 'x', y: 'y', ref: 'traj' },
        { op: 'plot', source: '$rv', ref: 'curve' },
      ],
      'ai',
    );
    expect(r.errors).toEqual([]);
    return { k, refs: r.refs };
  };

  it('formula and simulation agree in a vacuum, and link along the arrows', () => {
    const { k, refs } = build();
    const rv = scalarOf(k.state(), obj(k, refs.rv));
    const sim = systemOf(k.state(), obj(k, refs.sys));
    expect(rv.ok && sim.ok).toBe(true);
    if (!rv.ok || !sim.ok) return;
    expect(sim.value.outputs.x_end).toBeCloseTo(rv.value, 1);
    expect(sim.value.outputs.y_max).toBeCloseTo((25 * Math.sin(Math.PI / 6)) ** 2 / (2 * 9.81), 1);
    const feeds = Object.values(k.state().relations).filter((x) => x.type === 'feeds_into' && x.to === refs.sys).map((x) => obj(k, x.from).state.name);
    expect(feeds.sort()).toEqual(['g', 'k', 'theta', 'v0']);
    expect(obj(k, refs.curve).params).toMatchObject({ mode: 'curve', x: 'theta' });
    expect(obj(k, refs.traj).params).toMatchObject({ mode: 'series', x: 'x', y: 'y' });
  });

  it('a class prediction, tested: 45° wins in a vacuum, loses with air', () => {
    const { k, refs } = build();
    const test = (ref: string) =>
      k.dispatch(
        [
          {
            op: 'experiment',
            target: refs.sys,
            ref,
            variable: { param: 'theta', values: [30, 40, 45, 50, 60] },
            hypothesis: { text: '45° goes farthest', expect: [30, 40, 50, 60].map((a) => ({ value: 45, metric: 'x_end', op: '>=', than: a })) },
          },
        ],
        'human',
      );
    const c = k.dispatch([{ op: 'claim', text: '45° gives the longest range', about: [refs.sys], ref: 'c' }], 'human');
    const e1 = test('e1');
    expect(e1.errors).toEqual([]);
    expect(obj(k, e1.refs.e1).state.supported).toBe(true);
    k.dispatch([{ op: 'verify_claim', claim: c.refs.c, evidence: e1.refs.e1 }], 'human');
    expect(obj(k, c.refs.c).state.status).toBe('supported');

    // what if there is air? branch the construction with drag, and test again there
    const ids = Object.values(k.state().objects).filter((o) => ['variable', 'formula', 'system'].includes(o.kind)).map((o) => o.id);
    const b = k.dispatch([{ op: 'branch', ids, assumption: 'with air drag', changes: [{ id: refs.k, param: 'value', value: 0.03 }], ref: 'bk' }], 'ai');
    expect(b.errors).toEqual([]);
    const branchSys = Object.values(k.state().objects).find((o) => o.kind === 'system' && o.id !== refs.sys)!;
    const e2 = k.dispatch([{ op: 'experiment', target: branchSys.id, ref: 'e2', variable: { param: 'theta', values: [30, 40, 45, 50, 60] }, hypothesis: { text: '45° goes farthest (with air)', expect: [30, 40, 50, 60].map((a) => ({ value: 45, metric: 'x_end', op: '>=', than: a })) } }], 'ai');
    expect(e2.errors).toEqual([]);
    expect(obj(k, e2.refs.e2).state.supported).toBe(false);
    // the original is untouched
    expect(obj(k, refs.k).params.value).toBe(0);

    // experiments reproduce exactly, even after the sliders move
    k.dispatch([{ op: 'set_parameter', id: refs.th, param: 'value', value: 70 }], 'human');
    k.dispatch([{ op: 'reproduce', id: e1.refs.e1 }], 'human');
    expect(obj(k, e1.refs.e1).state.reproductions[0].match).toBe(true);
  });

  it('a curve sweeps the variable behind a formula', () => {
    const { k, refs } = build();
    const s = sweep(k.state(), obj(k, refs.rv), 'theta', 0, 90, 90);
    expect(s.ok).toBe(true);
    if (s.ok) expect(s.value.xs[s.value.ys.indexOf(Math.max(...s.value.ys))]).toBe(45);
  });
});

describe('biology: an SIR epidemic and herd immunity', () => {
  it('stops taking off above 1 − 1/R0', () => {
    const k = new Kernel();
    const r = k.dispatch(
      [
        { op: 'create_object', kind: 'variable', name: 'beta', value: 0.3, min: 0, max: 1 },
        { op: 'create_object', kind: 'variable', name: 'gamma', value: 0.1, min: 0.01, max: 0.5 },
        { op: 'create_object', kind: 'variable', name: 'vacc', value: 0, min: 0, max: 1, label: 'Vaccinated fraction' },
        { op: 'create_object', kind: 'formula', name: 'R0', expr: 'beta/gamma' },
        { op: 'create_object', kind: 'formula', name: 'threshold', expr: '1 - 1/R0' },
        {
          op: 'create_object',
          kind: 'system',
          name: 'outbreak',
          ref: 'sir',
          vars: [
            { name: 'S', init: '1 - vacc - 0.001', rate: '-beta*S*I' },
            { name: 'I', init: '0.001', rate: 'beta*S*I - gamma*I' },
            { name: 'R', init: '0', rate: 'gamma*I' },
          ],
          t_max: 300,
          dt: 0.1,
        },
        { op: 'create_object', kind: 'formula', name: 'ever_infected', expr: '(R_end + I_end) * 100', unit: '%', ref: 'ever' },
        { op: 'plot', source: '$sir', y: 'S,I,R' },
        { op: 'experiment', target: '$ever', ref: 'e', variable: { param: 'vacc', values: [0, 0.5, 0.6, 0.7, 0.8] }, hypothesis: { text: 'Beyond two thirds the outbreak fizzles', expect: [{ value: 0.7, metric: 'ever_infected', op: '<', threshold: 5 }, { value: 0.6, metric: 'ever_infected', op: '>', threshold: 5 }] } },
      ],
      'ai',
    );
    expect(r.errors).toEqual([]);
    expect(obj(k, r.refs.e).state.supported).toBe(true);
    const m = measure(k.state(), obj(k, r.refs.ever));
    expect(m.ok && m.value.ever_infected).toBeGreaterThan(90);
  });
});

describe('mathematics: Fourier series and the Gibbs overshoot', () => {
  it('more terms do not remove the ~9% overshoot', () => {
    const k = new Kernel();
    const r = k.dispatch(
      [
        { op: 'create_object', kind: 'variable', name: 'n', value: 5, min: 1, max: 60, step: 1, label: 'Terms' },
        { op: 'create_object', kind: 'variable', name: 'x', value: 1, min: -3.1416, max: 3.1416 },
        { op: 'create_object', kind: 'formula', name: 'square', expr: 'sign(sin(x))' },
        { op: 'create_object', kind: 'formula', name: 'S', expr: '4/pi * sum(k, 1, n, sin((2k-1)*x)/(2k-1))', ref: 'S' },
        { op: 'create_object', kind: 'formula', name: 'overshoot', expr: '(maxover(x, 0.0001, pi/2, S, 1500) - 1) / 2 * 100', unit: '%', ref: 'o' },
        { op: 'plot', source: ['square', '$S'], ref: 'p' },
        { op: 'experiment', target: '$o', ref: 'e', variable: { param: 'n', values: [1, 5, 20, 60] }, hypothesis: { text: 'enough terms remove the overshoot', expect: [{ value: 60, metric: 'overshoot', op: '<', threshold: 1 }] } },
      ],
      'human',
    );
    expect(r.errors).toEqual([]);
    expect(obj(k, r.refs.e).state.supported).toBe(false);
    const at60 = obj(k, r.refs.e).state.results.find((x: any) => x.value === 60).metrics.overshoot;
    expect(at60).toBeCloseTo(8.95, 0);
    expect(Object.values(k.state().relations).filter((x) => x.from === r.refs.p && x.type === 'visualizes')).toHaveLength(2);
  });
});

describe('statistics: the central limit theorem', () => {
  it('averages of a skewed distribution become symmetric, reproducibly', () => {
    const k = new Kernel();
    const r = k.dispatch(
      [
        { op: 'create_object', kind: 'variable', name: 'n', value: 1, min: 1, max: 50, step: 1, label: 'Sample size' },
        { op: 'create_object', kind: 'trials', name: 'M', expr: 'meanof(n, randexp(1))', trials: 3000, seed: 3, ref: 't' },
        { op: 'plot', source: '$t' },
        { op: 'experiment', target: '$t', ref: 'e', seeds: [1, 2, 3], variable: { param: 'n', values: [1, 5, 30] }, hypothesis: { text: 'skew shrinks as n grows', expect: [{ value: 30, metric: 'skew', op: '<', than: 1 }, { value: 30, metric: 'M_skew', op: '<', threshold: 0.6 }] } },
      ],
      'ai',
    );
    expect(r.errors).toEqual([]);
    const t1 = trialsOf(k.state(), obj(k, r.refs.t));
    const t2 = trialsOf(k.state(), obj(k, r.refs.t));
    expect(t1.ok && t2.ok && t1.value.stats.mean === t2.value.stats.mean).toBe(true);
    if (t1.ok) expect(t1.value.stats.skew).toBeGreaterThan(1.5); // exponential: skew 2
    expect(obj(k, r.refs.e).state.supported).toBe(true);
  });
});

describe('economics: who pays a tax', () => {
  it('the buyers\' share of a tax depends on the slopes, not on who is taxed', () => {
    const k = new Kernel();
    const r = k.dispatch(
      [
        ...[['a', 100], ['b', 1], ['c', 10], ['d', 1], ['tax', 10], ['q', 30]].map(([name, value]) => ({ op: 'create_object', kind: 'variable', name, value, min: 0, max: 200 })),
        { op: 'create_object', kind: 'formula', name: 'Q', expr: '(a - c - tax)/(b + d)' },
        { op: 'create_object', kind: 'formula', name: 'P0', expr: 'a - b*(a - c)/(b + d)' },
        { op: 'create_object', kind: 'formula', name: 'P_buyer', expr: 'a - b*Q' },
        { op: 'create_object', kind: 'formula', name: 'buyer_share', expr: '(P_buyer - P0)/tax * 100', unit: '%', ref: 's' },
        { op: 'create_object', kind: 'formula', name: 'demand', expr: 'a - b*q' },
        { op: 'create_object', kind: 'formula', name: 'supply', expr: 'c + d*q' },
        { op: 'plot', source: ['demand', 'supply'], x: 'q', from: 0, to: 100 },
      ],
      'ai',
    );
    expect(r.errors).toEqual([]);
    const s = scalarOf(k.state(), obj(k, r.refs.s));
    expect(s.ok && s.value).toBeCloseTo(50, 6);
    const d = Object.values(k.state().objects).find((o) => o.kind === 'variable' && o.state.name === 'd')!;
    k.dispatch([{ op: 'set_parameter', id: d.id, param: 'value', value: 3 }], 'human');
    const s2 = scalarOf(k.state(), obj(k, r.refs.s));
    expect(s2.ok && s2.value).toBeCloseTo(25, 6); // b/(b+d)
  });
});

describe('the protocol explains mistakes', () => {
  it('rejects undefined names, bad syntax, ambiguity and cycles with precise errors', () => {
    const k = new Kernel();
    expect(k.dispatch([{ op: 'create_object', kind: 'formula', name: 'y', expr: 'm*x + b' }], 'ai').errors[0]).toMatch(/"m" is not defined/);
    expect(k.dispatch([{ op: 'create_object', kind: 'formula', name: 'y', expr: 'sin(x' }], 'ai').errors[0]).toMatch(/expected "\)"/);
    k.dispatch([{ op: 'create_object', kind: 'variable', name: 'x', value: 1 }, { op: 'create_object', kind: 'variable', name: 'x', value: 2 }], 'human');
    expect(k.dispatch([{ op: 'create_object', kind: 'formula', name: 'y', expr: '2x' }], 'ai').errors[0]).toMatch(/ambiguous/);
    const ok = k.dispatch([{ op: 'create_object', kind: 'formula', name: 'y', expr: '2x', inputs: { x: 'var_1' }, ref: 'y' }], 'ai');
    expect(ok.errors).toEqual([]);
    const q = k.dispatch([{ op: 'create_object', kind: 'formula', name: 'q', expr: 'y + 1', ref: 'q' }], 'ai');
    expect(q.errors).toEqual([]);
    expect(k.dispatch([{ op: 'modify_object', id: ok.refs.y, state: { expr: '2x + q' }, inputs: { x: 'var_1' } }], 'ai').errors[0]).toMatch(/circular/);
    const v = semanticView(k.state()) as any;
    expect(v.objects.find((o: any) => o.id === ok.refs.y).value).toBe(2);
  });
});
