// Live computation over the canvas: variables (sliders), formulas, systems of differential
// equations, and random trials. Names resolve along explicit feeds_into relations — the
// arrows on the canvas are the dependency graph. Everything is deterministic (trials are
// seeded) and nothing here mutates the workspace.

import type { ObjectId, TSObject, Workspace } from './types';
import { check, evaluate, ExprError, parse, seeded, usesRandom, type Ast } from './expr';

export const CALC_KINDS = ['variable', 'formula', 'system', 'trials'] as const;
export type CalcKind = (typeof CALC_KINDS)[number];
export const isCalc = (o: TSObject | undefined): boolean => !!o && (CALC_KINDS as readonly string[]).includes(o.kind);

export type Overrides = Record<string, number>;

export interface SystemVar {
  name: string;
  init: string;
  rate: string;
}

export interface SystemRun {
  t: number[];
  series: Record<string, number[]>;
  outputs: Record<string, number>;
  stoppedAt: number | null;
}

export interface TrialsRun {
  values: number[];
  stats: Record<string, number>;
  hist: { edges: number[]; counts: number[] };
}

export type Calc<T> = { ok: true; value: T } | { ok: false; error: string };

const astCache = new Map<string, Ast>();
function ast(src: string): Ast {
  let a = astCache.get(src);
  if (!a) {
    a = parse(src);
    if (astCache.size > 5000) astCache.clear();
    astCache.set(src, a);
  }
  return a;
}

// ------------------------------------------------------------------ names

/** names an object offers to the objects it feeds */
export function providedNames(o: TSObject): string[] {
  switch (o.kind) {
    case 'variable':
    case 'formula':
      return [o.state.name];
    case 'system': {
      const names = [...(o.state.vars as SystemVar[]).map((v) => v.name), ...((o.state.helpers ?? []) as { name: string }[]).map((h) => h.name)];
      return ['t_end', ...names.flatMap((n) => [`${n}_end`, `${n}_max`, `${n}_min`, `t_${n}_max`])];
    }
    case 'trials':
      return ['mean', 'sd', 'skew', 'kurtosis', 'median', 'min', 'max'].map((s) => `${o.state.name}_${s}`);
    default:
      return [];
  }
}

/** names an object's own expressions bind locally (so they need no provider) */
export function localNames(o: TSObject): Set<string> {
  if (o.kind === 'system') return new Set(['t', ...(o.state.vars as SystemVar[]).map((v) => v.name), ...((o.state.helpers ?? []) as { name: string }[]).map((h) => h.name)]);
  return new Set();
}

/** every expression an object evaluates */
export function expressionsOf(o: TSObject): string[] {
  switch (o.kind) {
    case 'formula':
      return [o.state.expr];
    case 'trials':
      return [o.state.expr];
    case 'system':
      return [
        ...(o.state.vars as SystemVar[]).flatMap((v) => [v.init, v.rate]),
        ...((o.state.helpers ?? []) as { expr: string }[]).map((h) => h.expr),
        ...(o.state.stop ? [o.state.stop as string] : []),
      ];
    default:
      return [];
  }
}

/** free names across an object's expressions, minus what it binds itself */
export function neededNames(o: TSObject): string[] {
  const local = localNames(o);
  const out = new Set<string>();
  for (const src of expressionsOf(o)) for (const n of check(src).names) if (!local.has(n)) out.add(n);
  return [...out];
}

export function providers(ws: Workspace, id: ObjectId): TSObject[] {
  return Object.values(ws.relations)
    .filter((r) => r.type === 'feeds_into' && r.to === id)
    .map((r) => ws.objects[r.from])
    .filter((o): o is TSObject => !!o && isCalc(o));
}

// ------------------------------------------------------------------ evaluation

class Evaluator {
  private memo = new Map<string, number | SystemRun | TrialsRun>();
  constructor(
    readonly ws: Workspace,
    readonly overrides: Overrides,
    readonly seed?: number,
    private stack = new Set<string>(),
  ) {}

  /** resolve a free name for a consumer object */
  resolver(consumer: ObjectId) {
    return (name: string, bound: Record<string, number> = {}): number | undefined => {
      if (name in this.overrides) return this.overrides[name];
      // Names bound by maxover/integrate/sum… shadow the sliders of the same name
      // all the way down the chain of formulas, so evaluate providers afresh.
      const ev = Object.keys(bound).length ? new Evaluator(this.ws, { ...this.overrides, ...bound }, this.seed, this.stack) : this;
      for (const p of providers(this.ws, consumer)) {
        if ((p.kind === 'variable' || p.kind === 'formula') && p.state.name === name) return ev.scalar(p);
        if (p.kind === 'system' && providedNames(p).includes(name)) return ev.system(p).outputs[name];
        if (p.kind === 'trials' && providedNames(p).includes(name)) return ev.trials(p).stats[name.slice(p.state.name.length + 1)];
      }
      return undefined;
    };
  }

  private guard<T>(id: string, f: () => T): T {
    if (this.stack.has(id)) throw new ExprError(`circular dependency through ${this.ws.objects[id]?.state?.name ?? id}`);
    this.stack.add(id);
    try {
      return f();
    } finally {
      this.stack.delete(id);
    }
  }

  scalar(o: TSObject): number {
    if (o.kind === 'variable') return o.state.name in this.overrides ? this.overrides[o.state.name] : Number(o.params.value);
    if (o.state.name in this.overrides) return this.overrides[o.state.name];
    const key = `s:${o.id}`;
    const hit = this.memo.get(key);
    if (hit !== undefined) return hit as number;
    const v = this.guard(o.id, () => {
      const resolve = this.resolver(o.id);
      return evaluate(ast(o.state.expr), { resolve: (n, b) => resolve(n, b) });
    });
    this.memo.set(key, v);
    return v;
  }

  system(o: TSObject): SystemRun {
    const key = `y:${o.id}`;
    const hit = this.memo.get(key);
    if (hit) return hit as SystemRun;
    const run = this.guard(o.id, () => integrate(o, this.resolver(o.id)));
    this.memo.set(key, run);
    return run;
  }

  trials(o: TSObject): TrialsRun {
    const key = `r:${o.id}`;
    const hit = this.memo.get(key);
    if (hit) return hit as TrialsRun;
    const run = this.guard(o.id, () => repeat(o, this.resolver(o.id), this.seed ?? Number(o.params.seed)));
    this.memo.set(key, run);
    return run;
  }
}

function integrate(o: TSObject, resolve: (n: string) => number | undefined): SystemRun {
  const vars = o.state.vars as SystemVar[];
  const helpers = (o.state.helpers ?? []) as { name: string; expr: string }[];
  const tMax = Number(o.params.t_max);
  const dt = Number(o.params.dt);
  if (!(tMax > 0) || !(dt > 0)) throw new ExprError('t_max and dt must be positive');
  const steps = Math.ceil(tMax / dt);
  if (steps > 400000) throw new ExprError('too many steps: increase dt or reduce t_max');
  const names = vars.map((v) => v.name);
  const initA = vars.map((v) => ast(v.init));
  const rateA = vars.map((v) => ast(v.rate));
  const helpA = helpers.map((h) => ast(h.expr));
  const stopA = o.state.stop ? ast(o.state.stop) : null;
  const ctx = { resolve: (n: string) => resolve(n) };

  const env = (t: number, y: number[]) => {
    const b: Record<string, number> = { t };
    names.forEach((n, i) => (b[n] = y[i]));
    helpers.forEach((h, i) => (b[h.name] = evaluate(helpA[i], ctx, b)));
    return b;
  };
  const deriv = (t: number, y: number[]) => {
    const b = env(t, y);
    return rateA.map((r) => evaluate(r, ctx, b));
  };
  const rk4 = (t: number, y: number[], h: number) => {
    const k1 = deriv(t, y);
    const k2 = deriv(t + h / 2, y.map((v, i) => v + (h * k1[i]) / 2));
    const k3 = deriv(t + h / 2, y.map((v, i) => v + (h * k2[i]) / 2));
    const k4 = deriv(t + h, y.map((v, i) => v + h * k3[i]));
    return y.map((v, i) => v + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
  };
  const stopped = (t: number, y: number[]) => !!stopA && t > 0 && !!evaluate(stopA, ctx, env(t, y));

  let t = 0;
  let y = initA.map((a) => evaluate(a, ctx, { t: 0 }));
  const every = Math.max(1, Math.floor(steps / 600));
  const T: number[] = [];
  const S: Record<string, number[]> = {};
  for (const n of [...names, ...helpers.map((h) => h.name)]) S[n] = [];
  const record = (t: number, y: number[]) => {
    const b = env(t, y);
    T.push(t);
    for (const n in S) S[n].push(b[n]);
  };
  record(t, y);
  let stoppedAt: number | null = null;
  for (let i = 1; i <= steps; i++) {
    const h = Math.min(dt, tMax - t);
    if (h <= 0) break;
    const next = rk4(t, y, h);
    if (stopped(t + h, next)) {
      // bisect for the moment the stop condition becomes true
      let lo = 0, hi = h;
      for (let k = 0; k < 30; k++) {
        const mid = (lo + hi) / 2;
        if (stopped(t + mid, rk4(t, y, mid))) hi = mid;
        else lo = mid;
      }
      y = rk4(t, y, hi);
      t += hi;
      stoppedAt = t;
      record(t, y);
      break;
    }
    y = next;
    t += h;
    if (!y.every(Number.isFinite)) throw new ExprError(`the system blew up at t = ${t.toPrecision(3)} (try a smaller dt)`);
    if (i % every === 0 || i === steps) record(t, y);
  }
  const outputs: Record<string, number> = { t_end: t };
  for (const n in S) {
    const s = S[n];
    let mx = -Infinity, mn = Infinity, tmx = 0;
    s.forEach((v, i) => {
      if (v > mx) (mx = v), (tmx = T[i]);
      if (v < mn) mn = v;
    });
    outputs[`${n}_end`] = s[s.length - 1];
    outputs[`${n}_max`] = mx;
    outputs[`${n}_min`] = mn;
    outputs[`t_${n}_max`] = tmx;
  }
  return { t: T, series: S, outputs, stoppedAt };
}

function repeat(o: TSObject, resolve: (n: string) => number | undefined, seed: number): TrialsRun {
  const n = Math.round(Number(o.params.trials));
  const a = ast(o.state.expr);
  const rng = seeded(seed * 2654435761 + 97);
  const ctx = { resolve: (x: string) => resolve(x), rng };
  const values: number[] = [];
  for (let i = 0; i < n; i++) values.push(evaluate(a, ctx));
  return { values, stats: statistics(values), hist: histogram(values, Math.round(Number(o.params.bins))) };
}

export function statistics(v: number[]): Record<string, number> {
  const n = v.length || 1;
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const m2 = v.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  const m3 = v.reduce((s, x) => s + (x - mean) ** 3, 0) / n;
  const m4 = v.reduce((s, x) => s + (x - mean) ** 4, 0) / n;
  const sd = Math.sqrt(m2);
  const sorted = [...v].sort((a, b) => a - b);
  return {
    mean,
    sd,
    skew: sd > 0 ? m3 / sd ** 3 : 0,
    kurtosis: sd > 0 ? m4 / sd ** 4 - 3 : 0,
    median: sorted[Math.floor((sorted.length - 1) / 2)] ?? 0,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function histogram(v: number[], bins: number) {
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const discrete = v.every((x) => Number.isInteger(x)) && hi - lo <= 80;
  const edges: number[] = [];
  if (discrete) for (let x = lo - 0.5; x <= hi + 0.5 + 1e-9; x++) edges.push(x);
  else {
    const w = (hi - lo || 1) / bins;
    for (let i = 0; i <= bins; i++) edges.push(lo + i * w);
  }
  const counts = new Array(edges.length - 1).fill(0);
  for (const x of v) {
    let i = Math.floor(((x - edges[0]) / (edges[edges.length - 1] - edges[0])) * counts.length);
    i = Math.min(counts.length - 1, Math.max(0, i));
    counts[i]++;
  }
  return { edges, counts };
}

// ------------------------------------------------------------------ public API

const wrap = <T>(f: () => T): Calc<T> => {
  try {
    return { ok: true, value: f() };
  } catch (e) {
    return { ok: false, error: e instanceof ExprError ? e.message : `error: ${(e as Error).message}` };
  }
};

export function scalarOf(ws: Workspace, o: TSObject, overrides: Overrides = {}): Calc<number> {
  return wrap(() => new Evaluator(ws, overrides).scalar(o));
}

export function systemOf(ws: Workspace, o: TSObject, overrides: Overrides = {}): Calc<SystemRun> {
  return wrap(() => new Evaluator(ws, overrides).system(o));
}

export function trialsOf(ws: Workspace, o: TSObject, overrides: Overrides = {}, seed?: number): Calc<TrialsRun> {
  return wrap(() => new Evaluator(ws, overrides, seed).trials(o));
}

/** the measurable quantities of a calc object — what experiments and comparisons read */
export function measure(ws: Workspace, o: TSObject, overrides: Overrides = {}, seed?: number): Calc<Record<string, number>> {
  return wrap(() => {
    const e = new Evaluator(ws, overrides, seed);
    if (o.kind === 'variable' || o.kind === 'formula') return { [o.state.name]: e.scalar(o) };
    if (o.kind === 'system') return e.system(o).outputs;
    if (o.kind === 'trials') {
      const s = e.trials(o).stats;
      return Object.fromEntries(Object.entries(s).map(([k, v]) => [`${o.state.name}_${k}`, v]));
    }
    throw new ExprError(`${o.kind} objects have nothing to measure`);
  });
}

/** evaluate a formula while sweeping one variable (for curve plots) */
export function sweep(ws: Workspace, o: TSObject, name: string, from: number, to: number, n = 200, overrides: Overrides = {}): Calc<{ xs: number[]; ys: number[] }> {
  return wrap(() => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i <= n; i++) {
      const x = from + ((to - from) * i) / n;
      xs.push(x);
      const v = new Evaluator(ws, { ...overrides, [name]: x }).scalar(o);
      ys.push(Number.isFinite(v) ? v : NaN);
    }
    return { xs, ys };
  });
}

/** every variable an object depends on, transitively (for experiments and curve plots) */
export function variablesBehind(ws: Workspace, id: ObjectId, seen = new Set<string>()): TSObject[] {
  const out: TSObject[] = [];
  for (const p of providers(ws, id)) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    if (p.kind === 'variable') out.push(p);
    else out.push(...variablesBehind(ws, p.id, seen));
  }
  return out;
}

export function isRandom(ws: Workspace, id: ObjectId, seen = new Set<string>()): boolean {
  const o = ws.objects[id];
  if (!o || seen.has(id)) return false;
  seen.add(id);
  if (o.kind === 'trials') return true;
  if (expressionsOf(o).some((s) => usesRandom(ast(s)))) return true;
  return providers(ws, id).some((p) => isRandom(ws, p.id, seen));
}

export function fmt(x: number | undefined, digits = 3): string {
  if (x === undefined || Number.isNaN(x)) return '—';
  if (!Number.isFinite(x)) return x > 0 ? '∞' : '−∞';
  const a = Math.abs(x);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return x.toExponential(2);
  return String(+x.toPrecision(digits + (a >= 100 ? 1 : 0)));
}
