import { describe, expect, it } from 'vitest';
import { check, evaluate, parse, seeded, toLatex, freeNames, ExprError } from '../src/kernel/expr';

const val = (src: string, env: Record<string, number> = {}, seed?: number) =>
  evaluate(parse(src), { resolve: (n) => env[n], rng: seed === undefined ? undefined : seeded(seed) });

describe('expression language', () => {
  it('computes with precedence, implicit multiplication and unicode names', () => {
    expect(val('1 + 2 * 3 ^ 2')).toBe(19);
    expect(val('-x^2', { x: 3 })).toBe(-9);
    expect(val('2x + 1', { x: 4 })).toBe(9);
    expect(val('2(k-1)', { k: 3 })).toBe(4);
    expect(val('v^2 * sin(2*rad(θ)) / g', { v: 25, θ: 45, g: 9.81 })).toBeCloseTo(63.7105, 3);
    expect(val('x > 1 ? 10 : 20', { x: 2 })).toBe(10);
    expect(val('a·b', { a: 3, b: 4 })).toBe(12);
  });

  it('binds variables in sums, integrals, extrema and derivatives', () => {
    expect(val('sum(k, 1, 100, k)')).toBe(5050);
    expect(val('integrate(x, 0, pi, sin(x))')).toBeCloseTo(2, 6);
    expect(val('maxover(x, 0, 2, x*(2-x))')).toBeCloseTo(1, 6);
    expect(val('argmax(t, 0, 90, sin(2*rad(t)))')).toBeCloseTo(45, 1);
    expect(val('diff(x, 3, x^2)')).toBeCloseTo(6, 5);
    // Gibbs: the square-wave partial sum overshoots by ~9% of the jump
    const S = '4/pi * sum(k, 1, n, sin((2k-1)*x)/(2k-1))';
    const over = (n: number) => (val(`maxover(x, 0.0001, pi/2, ${S}, 2000)`, { n }) - 1) / 2;
    expect(over(60)).toBeCloseTo(0.0895, 2);
  });

  it('is deterministic under a seed', () => {
    const a = val('meanof(1000, rand())', {}, 7);
    expect(a).toBe(val('meanof(1000, rand())', {}, 7));
    expect(a).toBeCloseTo(0.5, 1);
    expect(() => val('rand()')).toThrow(ExprError);
  });

  it('reports what it depends on and explains mistakes', () => {
    expect([...freeNames(parse('sum(k, 1, n, x^k) + integrate(t, 0, T, t*a)'))].sort()).toEqual(['T', 'a', 'n', 'x']);
    expect([...freeNames(parse('maxover(x, a, b, x*c, 500)'))].sort()).toEqual(['a', 'b', 'c']);
    expect(() => check('sin(x')).toThrow(/expected "\)"/);
    expect(() => check('foo(1)')).toThrow(/unknown function "foo"/);
    expect(() => val('y + 1')).toThrow(/unknown name "y"/);
  });

  it('typesets as LaTeX', () => {
    const t = toLatex(parse('v^2*sin(2*rad(theta))/g'));
    expect(t.startsWith('\\frac{')).toBe(true);
    expect(t).toContain('\\sin');
    expect(toLatex(parse('sum(k, 1, n, 1/k)'))).toBe('\\sum_{k=1}^{n} \\frac{1}{k}');
    expect(toLatex(parse('beta*S*I'))).toBe('\\beta \\cdot S \\cdot I');
    expect(toLatex(parse('x_end'))).toBe('x_{\\mathrm{end}}');
  });
});
