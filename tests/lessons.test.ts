// Open lessons through the offline planner: the generic building blocks first (they work
// for any subject), then every ready-made starter, driven the way a class would use it.

import { describe, expect, it } from 'vitest';
import { Kernel, measure, type ObjectId } from '../src/kernel';
import { localAgent } from '../src/agent/local';
import { LESSON_PROMPTS } from '../src/agent/lessons';
import type { AgentHost } from '../src/agent/host';

function harness() {
  const kernel = new Kernel();
  let selection: ObjectId[] = [];
  const said: string[] = [];
  const host: AgentHost = {
    kernel,
    selection: () => selection,
    apply: (ops, summary) => kernel.dispatch(ops, 'ai', { summary }),
    highlight: () => {},
    focus: () => {},
    say: (t) => said.push(t),
    status: () => {},
  };
  const ask = async (text: string, sel: ObjectId[] = selection) => {
    selection = sel;
    await localAgent.run(text, host, []);
    return said[said.length - 1];
  };
  const all = () => Object.values(kernel.state().objects) as any[];
  const find = (pred: (o: any) => boolean) => all().find(pred)!;
  const named = (name: string) => find((o) => o.state?.name === name && !o.visual.hidden);
  return { kernel, ask, said, all, find, named, select: (s: ObjectId[]) => (selection = s) };
}

describe('typed mathematics', () => {
  it('a formula with unknown names becomes sliders, a live formula and its curve', async () => {
    const h = harness();
    const msg = await h.ask('y = a*x^2 + b*x + c');
    expect(msg).toMatch(/sliders? for a, x, b, c/);
    expect(['a', 'b', 'c', 'x'].every((n) => h.named(n).kind === 'variable')).toBe(true);
    const plot = h.find((o) => o.kind === 'graph');
    expect(plot.params).toMatchObject({ mode: 'curve', x: 'x' });
    // setting a slider by typing
    await h.ask('a = -2');
    expect(h.named('a').params.value).toBe(-2);
    const y = measure(h.kernel.state(), h.named('y'));
    expect(y.ok && y.value.y).toBe(-2 + 1 + 1);
  });

  it('rates of change become a system; ~ becomes random trials', async () => {
    const h = harness();
    await h.ask('dN/dt = r*N*(1 - N/K); N(0) = 5; K = 100');
    const sys = h.find((o) => o.kind === 'system');
    expect(sys.state.vars).toEqual([{ name: 'N', init: '5', rate: 'r*N*(1 - N/K)' }]);
    expect(h.named('K').params.value).toBe(100);
    expect(h.find((o) => o.kind === 'graph').params.mode).toBe('series');
    await h.ask('X ~ randint(1, 6) + randint(1, 6)');
    const X = h.named('X');
    const m = measure(h.kernel.state(), X);
    expect(m.ok && m.value.X_mean).toBeCloseTo(7, 0);
    expect(h.all().filter((o) => o.kind === 'graph').map((g) => g.params.mode)).toContain('histogram');
  });

  it('reports typos before creating anything', async () => {
    const h = harness();
    expect(await h.ask('y = sin(x')).toMatch(/couldn't read/);
    expect(h.all()).toHaveLength(0);
  });

  it('tests predictions written in words, then answers what-if and why', async () => {
    const h = harness();
    await h.ask('y = a*x^2 + b; a = 1; b = 0');
    expect(await h.ask('test: y increases as a increases')).toMatch(/holds/);
    const claim = h.find((o) => o.kind === 'claim');
    expect(claim.state.status).toBe('supported');
    expect(h.find((o) => o.kind === 'experiment').state.mode).toBe('calc');

    await h.ask('test: y is below 3 when x = 1');
    expect(h.all().filter((o) => o.kind === 'claim').map((c) => c.state.status)).toEqual(['supported', 'supported']);

    const w = await h.ask('what if a = 3?');
    expect(w).toMatch(/a = 3/);
    expect(h.find((o) => o.kind === 'comparison')).toBeTruthy();
    expect(await h.ask('why is y so big?', [h.named('y').id])).toMatch(/depends on/);
  });
});

describe('ready-made lessons end in a testable prediction', () => {
  const cases: [string, 'supported' | 'refuted'][] = [
    [LESSON_PROMPTS[0], 'supported'], // no drag: 45° wins
    [LESSON_PROMPTS[1], 'supported'], // R0 = 2.5 → herd immunity at 60%
    [LESSON_PROMPTS[2], 'refuted'], // Gibbs: ~9% overshoot stays
    [LESSON_PROMPTS[3], 'supported'], // σ/√n
    [LESSON_PROMPTS[4], 'refuted'], // buyers pay half with equal slopes
  ];
  for (const [prompt, verdict] of cases)
    it(prompt, async () => {
      const h = harness();
      await h.ask(prompt);
      const claim = h.find((o) => o.kind === 'claim');
      expect(claim, h.said.join('\n')).toBeTruthy();
      await h.ask('Run an experiment to test this claim.', [claim.id]);
      expect(h.kernel.state().objects[claim.id].state.status, h.said.join('\n')).toBe(verdict);
    });

  it('the projectile answer changes with air drag', async () => {
    const h = harness();
    await h.ask(LESSON_PROMPTS[0]);
    h.kernel.dispatch([{ op: 'set_parameter', id: h.named('k').id, param: 'value', value: 0.05 }], 'human');
    const text = h.find((o) => o.kind === 'claim').state.text;
    expect(await h.ask(`test: ${text}`, [])).toMatch(/fails/);
  });
});
