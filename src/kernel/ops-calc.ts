// Operations for the open-lesson building blocks (variable, formula, system, trials):
// creation shorthands, validation, automatic name linking, plots and experiments.
// Everything is validated here so a model (or a student) gets a precise error back.

import type { ObjectId, Operation, ParamValue, TSObject } from './types';
import type { TxBuilder } from './ops';
import { OpError } from './ops';
import { coerceParam, isIdentifier } from './kinds';
import { check, ExprError, LANGUAGE_DOC } from './expr';
import { axisCandidates, fmt, isCalc, isRandom, measure, neededNames, providedNames, providers, statistics, variablesBehind, type Overrides } from './calc';
import { hashString } from './nn';

const fail = (m: string): never => {
  throw new OpError(m);
};

export const CALC_EDITABLE: Record<string, string[]> = {
  variable: ['name', 'unit', 'description'],
  formula: ['name', 'expr', 'unit', 'description'],
  system: ['name', 'vars', 'helpers', 'stop', 'description'],
  trials: ['name', 'expr', 'description'],
};

const STATE_KEYS = ['name', 'expr', 'unit', 'description', 'vars', 'helpers', 'stop'];
const PARAM_KEYS = ['value', 'min', 'max', 'step', 't_max', 'dt', 'trials', 'seed', 'bins'];

function exprOk(src: unknown, what: string): string {
  if (typeof src !== 'string' || !src.trim()) fail(`${what}: expected an expression`);
  try {
    check(src as string);
  } catch (e) {
    fail(`${what}: ${(e as Error).message} in "${src}"`);
  }
  return (src as string).trim();
}

/** validate a state patch for a calc kind (types and expressions) */
export function checkCalcState(kind: string, patch: Record<string, unknown>) {
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'name' && !isIdentifier(v)) fail(`state.name: "${v}" is not a valid name (letters, digits, _; e.g. theta, v0, R_eff)`);
    if ((k === 'unit' || k === 'description') && typeof v !== 'string') fail(`state.${k}: expected a string`);
    if (k === 'expr') patch.expr = exprOk(v, 'expr');
    if (k === 'stop' && v !== '' && v !== undefined) patch.stop = exprOk(v, 'stop');
    if (k === 'vars') {
      if (!Array.isArray(v) || v.length === 0 || v.length > 12) fail('vars: expected 1–12 items like {"name": "x", "init": "0", "rate": "vx"}');
      const names = new Set<string>();
      patch.vars = (v as any[]).map((x, i) => {
        if (!isIdentifier(x?.name)) fail(`vars[${i}].name: expected a name`);
        if (names.has(x.name)) fail(`vars: "${x.name}" appears twice`);
        names.add(x.name);
        return { name: x.name, init: exprOk(String(x.init ?? '0'), `vars[${i}].init`), rate: exprOk(String(x.rate ?? x.derivative ?? x.ddt ?? ''), `vars[${i}].rate (d${x.name}/dt)`) };
      });
    }
    if (k === 'helpers') {
      if (!Array.isArray(v) || v.length > 12) fail('helpers: expected up to 12 items like {"name": "speed", "expr": "hypot(vx, vy)"}');
      patch.helpers = (v as any[]).map((x, i) => {
        if (!isIdentifier(x?.name)) fail(`helpers[${i}].name: expected a name`);
        return { name: x.name, expr: exprOk(x.expr, `helpers[${i}].expr`) };
      });
    }
  }
  if (kind !== 'variable' && kind !== 'system' && patch.expr === undefined && 'expr' in patch) fail('expr: required');
}

/** accept flat shorthands: {kind: "variable", name: "theta", value: 45, min: 0, max: 90} */
export function calcCreateArgs(op: Operation): { params: Record<string, unknown>; state: Record<string, unknown> } {
  const params: Record<string, unknown> = { ...(op.params ?? {}) };
  const state: Record<string, unknown> = { ...(op.state ?? {}) };
  for (const k of STATE_KEYS) if (op[k] !== undefined && state[k] === undefined) state[k] = op[k];
  for (const k of PARAM_KEYS) if (op[k] !== undefined && params[k] === undefined) params[k] = op[k];
  if (op.kind === 'variable') {
    const v = Number(params.value ?? 1);
    if (params.min === undefined) params.min = v >= 0 ? 0 : v * 2;
    if (params.max === undefined) params.max = v > 0 ? v * 2 : v === 0 ? 10 : 0;
    if (Number(params.min) > v) params.min = v;
    if (Number(params.max) < v) params.max = v;
  }
  if (!isIdentifier(state.name)) fail(`${op.kind}: give it a name (a valid identifier), e.g. {"name": "${op.kind === 'variable' ? 'theta' : op.kind === 'system' ? 'ball' : 'range'}"}`);
  if ((op.kind === 'formula' || op.kind === 'trials') && state.expr === undefined) fail(`${op.kind}: needs an expr, e.g. "v^2*sin(2*rad(theta))/g"`);
  if (op.kind === 'system' && state.vars === undefined) fail('system: needs vars: [{name, init, rate}], e.g. [{"name": "x", "init": "0", "rate": "v"}]');
  return { params, state };
}

/**
 * Link the names an object uses to the objects that provide them (feeds_into). Existing
 * links are kept when still needed; explicit `inputs` ({name: id}) win; otherwise a name
 * must be provided by exactly one visible object (preferring ones made in this batch).
 */
export function linkNames(tx: TxBuilder, id: ObjectId, inputs?: unknown, op = 'link') {
  const o = tx.get(id);
  if (!['formula', 'system', 'trials'].includes(o.kind)) return;
  let needed: string[];
  try {
    needed = neededNames(o);
  } catch (e) {
    return fail((e as Error).message);
  }
  const explicit = (inputs && typeof inputs === 'object' ? inputs : {}) as Record<string, unknown>;
  // drop links that no longer provide anything needed
  for (const r of Object.values(tx.ws.relations))
    if (r.type === 'feeds_into' && r.to === id) {
      const p = tx.ws.objects[r.from];
      if (p && isCalc(p) && !providedNames(p).some((n) => needed.includes(n))) tx.unrelate(r.id, op);
    }
  const have = new Set(providers(tx.ws, id).flatMap(providedNames));
  for (const name of needed) {
    if (explicit[name] !== undefined) {
      const pid = tx.id(explicit[name], `inputs.${name}`);
      const p = tx.get(pid);
      if (!providedNames(p).includes(name)) fail(`inputs.${name}: ${p.label} does not provide "${name}" (it provides ${providedNames(p).join(', ') || 'nothing'})`);
      if (!Object.values(tx.ws.relations).some((r) => r.type === 'feeds_into' && r.from === pid && r.to === id)) tx.relate('feeds_into', pid, id, op);
      have.add(name);
      continue;
    }
    if (have.has(name)) continue;
    const all = Object.values(tx.ws.objects).filter((c) => c.id !== id && isCalc(c) && providedNames(c).includes(name));
    const visible = all.filter((c) => !c.visual.hidden || c.parent === o.parent);
    const fresh = visible.filter((c) => tx.created.includes(c.id));
    const sameParent = visible.filter((c) => c.parent === o.parent);
    const pick = fresh.length === 1 ? fresh : sameParent.length === 1 ? sameParent : visible;
    if (pick.length === 0)
      fail(
        `"${name}" is not defined: create a variable (a slider) or a formula named ${name} first${
          /^[a-z]+$/.test(name) && name.length > 1 && all.length === 0 ? ' (or, if you meant a function, it is not a builtin one)' : ''
        }`,
      );
    if (pick.length > 1) fail(`"${name}" is ambiguous: ${pick.map((c) => `${c.id} (${c.label})`).join(', ')} — say which with inputs: {"${name}": "<id>"}`);
    tx.relate('feeds_into', pick[0].id, id, op);
    have.add(name);
  }
  // structural problems (cycles) surface now rather than as a broken card
  const m = measureOrScalar(tx, tx.get(id));
  if (m && /circular/.test(m)) fail(m);
}

function measureOrScalar(tx: TxBuilder, o: TSObject): string | undefined {
  const r = measure(tx.ws, o);
  return r.ok ? undefined : r.error;
}

export function describeValue(tx: TxBuilder, o: TSObject): string {
  const r = measure(tx.ws, o);
  if (!r.ok) return `${o.state.name}: ${r.error}`;
  const entries = Object.entries(r.value);
  if (o.kind === 'formula' || o.kind === 'variable') return `${o.state.name} = ${fmt(entries[0][1], 4)}${o.state.unit ? ` ${o.state.unit}` : ''}`;
  const pick = o.kind === 'system' ? entries.filter(([k]) => k.endsWith('_end') || k.endsWith('_max')).slice(0, 8) : entries;
  return `${o.state.name}: ${pick.map(([k, v]) => `${k}=${fmt(v, 4)}`).join(', ')}`;
}

// ------------------------------------------------------------------ plots

export function calcPlotParams(tx: TxBuilder, sources: TSObject[], op: Operation): { params: Record<string, ParamValue>; label: string } {
  const kinds = new Set(sources.map((s) => s.kind));
  if (kinds.size > 1) fail('plot: plot formulas together, or one system, or one set of trials');
  const s = sources[0];
  if (s.kind === 'variable') fail(`plot: a variable is a slider; plot a formula that uses ${s.state.name} against it`);
  if (s.kind === 'formula') {
    const behind = axisCandidates(tx.ws, sources);
    const x = typeof op.x === 'string' && op.x ? op.x : behind[0]?.state.name;
    if (!x) fail('plot: this formula depends on no variable, so there is nothing to put on the x-axis');
    if (!behind.some((v) => v.state.name === x)) fail(`plot: x must be a variable the formula uses: ${behind.map((v) => v.state.name).join(', ')}`);
    const from = op.from !== undefined ? Number(op.from) : 0;
    const to = op.to !== undefined ? Number(op.to) : 0;
    return { params: { mode: 'curve', x: x!, y: '', from, to }, label: `${sources.map((f) => f.state.name).join(', ')} vs ${x}` };
  }
  if (s.kind === 'system') {
    if (sources.length > 1) fail('plot: one system per plot');
    const series = ['t', ...(s.state.vars as { name: string }[]).map((v) => v.name), ...((s.state.helpers ?? []) as { name: string }[]).map((h) => h.name)];
    const x = typeof op.x === 'string' && op.x ? op.x : 't';
    const ys = (Array.isArray(op.y) ? op.y : typeof op.y === 'string' && op.y ? op.y.split(/[\s,]+/) : []).filter(Boolean) as string[];
    for (const n of [x, ...ys]) if (!series.includes(n)) fail(`plot: "${n}" is not a series of ${s.state.name} (series: ${series.join(', ')})`);
    return { params: { mode: 'series', x, y: ys.join(','), from: 0, to: 0 }, label: `${s.state.name}: ${ys.length ? ys.join(', ') : 'all'} vs ${x}` };
  }
  if (s.kind === 'trials') {
    if (sources.length > 1) fail('plot: one set of trials per histogram');
    return { params: { mode: 'histogram', x: '', y: '', from: 0, to: 0 }, label: `Distribution of ${s.state.name}` };
  }
  return fail(`plot: cannot plot a ${s.kind} this way`);
}

// ------------------------------------------------------------------ experiments

export interface CalcExpectation {
  value?: number;
  metric: string;
  op: '<' | '<=' | '>' | '>=' | '==';
  threshold?: number;
  than?: number;
}

export interface CalcExperimentSpec {
  target: ObjectId;
  hypothesis: { text: string; expect: CalcExpectation[] };
  variable: { param: string; values: number[] };
  seeds: number[];
  /** every other variable, frozen, so the experiment reproduces exactly */
  constants: Overrides;
}

const cmp = (v: number, op: CalcExpectation['op'], t: number) =>
  op === '<' ? v < t : op === '<=' ? v <= t : op === '>' ? v > t : op === '>=' ? v >= t : Math.abs(v - t) < 1e-9 * Math.max(1, Math.abs(t));

export function runCalcExperiment(ws: TxBuilder['ws'], spec: CalcExperimentSpec) {
  const target = ws.objects[spec.target];
  const results = spec.variable.values.map((value) => {
    const runs = spec.seeds.map((seed) => {
      const r = measure(ws, target, { ...spec.constants, [spec.variable.param]: value }, seed);
      if (!r.ok) throw new ExprError(`at ${spec.variable.param} = ${value}: ${r.error}`);
      return r.value;
    });
    const keys = Object.keys(runs[0]);
    const metrics: Record<string, number> = {};
    for (const k of keys) metrics[k] = runs.reduce((s, m) => s + m[k], 0) / runs.length;
    const spread: Record<string, number> = {};
    if (runs.length > 1) for (const k of keys) spread[k] = statistics(runs.map((m) => m[k])).sd;
    return { value, metrics, ...(runs.length > 1 ? { spread } : {}) };
  });
  const verdicts = spec.hypothesis.expect.map((e) => {
    const rel = results.filter((r) => e.value === undefined || r.value === e.value);
    const observed = rel.map((r) => r.metrics[e.metric]);
    const other = e.than !== undefined ? results.find((r) => r.value === e.than)?.metrics[e.metric] : e.threshold;
    const holds = rel.length > 0 && other !== undefined && Number.isFinite(other) && observed.every((v) => Number.isFinite(v) && cmp(v, e.op, other));
    return { expectation: e, holds, observed };
  });
  const supported = verdicts.length ? verdicts.every((v) => v.holds) : null;
  const focus = spec.hypothesis.expect[0]?.metric ?? Object.keys(results[0].metrics)[0];
  const hash = hashString(JSON.stringify(results.map((r) => [r.value, Object.entries(r.metrics).map(([k, v]) => [k, +v.toPrecision(10)])])));
  const conclusion =
    `${focus}: ${results.map((r) => `${fmt(r.value)} → ${fmt(r.metrics[focus], 4)}`).join(', ')}. ` +
    (supported === null ? 'Inconclusive: no testable expectation was given.' : supported ? 'Hypothesis supported.' : 'Hypothesis not supported.');
  return { results, verdicts, supported, focus, hash, conclusion };
}

export function calcExperimentSpec(tx: TxBuilder, target: TSObject, op: Operation, h: { text: string; expect: any[] }): CalcExperimentSpec {
  if (!['formula', 'system', 'trials'].includes(target.kind)) fail('experiment: the target must be a formula, system or random trials (what you measure)');
  const behind = variablesBehind(tx.ws, target.id);
  const name = op.variable?.param ?? op.variable?.name ?? op.variable?.variable;
  const v = behind.find((b) => b.state.name === name);
  if (!v) fail(`experiment: variable.param must be a variable ${target.state.name} depends on: ${behind.map((b) => b.state.name).join(', ') || 'none'}`);
  const vs = op.variable?.values;
  if (!Array.isArray(vs) || vs.length < 2 || vs.length > 10) fail('experiment: variable.values: 2–10 numbers');
  const values = (vs as unknown[]).map((x) => {
    const c = coerceParam({ name: 'value', type: 'number', default: 0, description: '' }, x);
    return c.error ? fail(`variable.values: ${c.error}`) : (c.value as number);
  });
  const random = isRandom(tx.ws, target.id);
  const seeds = op.seeds !== undefined ? (Array.isArray(op.seeds) ? op.seeds : fail('seeds: a list of integers')).map((s: unknown) => (Number.isInteger(s) ? s : fail('seeds: integers'))) : random ? [1, 2, 3, 4, 5] : [0];
  if (seeds.length > 12) fail('seeds: at most 12');
  const probe = measure(tx.ws, target);
  if (!probe.ok) return fail(`experiment: ${target.state.name} cannot be computed right now: ${probe.error}`);
  const keys = Object.keys(probe.value);
  const metricOf = (m: unknown): string => {
    if (typeof m === 'string' && keys.includes(m)) return m;
    if (typeof m === 'string' && keys.includes(`${target.state.name}_${m}`)) return `${target.state.name}_${m}`;
    if (m === 'value' && keys.length === 1) return keys[0];
    return fail(`expect.metric: one of ${keys.join(', ')}`);
  };
  const expect = h.expect.map((e: any) => {
    const ops: Record<string, string> = { lt: '<', lte: '<=', le: '<=', gt: '>', gte: '>=', ge: '>=', eq: '==', '=': '==', '≤': '<=', '≥': '>=' };
    const o = ops[e?.op] ?? e?.op;
    if (!['<', '<=', '>', '>=', '=='].includes(o)) fail('expect.op: < <= > >= ==');
    const num = (x: unknown, w: string) => (x === undefined ? undefined : Number.isFinite(Number(x)) ? Number(x) : fail(`${w}: a number`));
    const out: CalcExpectation = { metric: metricOf(e.metric), op: o as CalcExpectation['op'] };
    if (e.value !== undefined) out.value = num(e.value, 'expect.value');
    if (e.than !== undefined) out.than = num(e.than, 'expect.than');
    else if (e.threshold !== undefined) out.threshold = num(e.threshold, 'expect.threshold');
    else fail('expect: give a numeric threshold, or "than": another tested value to compare with');
    for (const w of [out.value, out.than]) if (w !== undefined && !values.includes(w)) fail(`expect: ${w} is not one of the tested values ${values.join(', ')}`);
    return out;
  });
  const constants: Overrides = {};
  for (const b of behind) if (b.state.name !== name) constants[b.state.name] = Number(b.params.value);
  return { target: target.id, hypothesis: { text: h.text, expect }, variable: { param: name, values }, seeds: seeds as number[], constants };
}

export const CALC_DOC = `Open-lesson building blocks (use these for any subject — physics, biology, economics, chemistry, statistics, maths…):
- variable: a slider. {"op": "create_object", "kind": "variable", "name": "theta", "value": 45, "min": 0, "max": 90, "unit": "°", "label": "Launch angle"}. Change with set_parameter {param: "value"}.
- formula: {"op": "create_object", "kind": "formula", "name": "range", "expr": "v^2*sin(2*rad(theta))/g", "unit": "m"}. Names in expr link automatically to the variables/formulas that provide them (create those first, in the same or an earlier batch; if a name is ambiguous give inputs: {"g": "var_3"}).
- system: {"op": "create_object", "kind": "system", "name": "ball", "vars": [{"name": "x", "init": "0", "rate": "vx"}, …], "helpers": [{"name": "speed", "expr": "hypot(vx, vy)"}], "stop": "y < 0", "t_max": 10, "dt": 0.01}. Outputs: t_end, and per variable v: v_end, v_max, v_min, t_v_max.
- trials: {"op": "create_object", "kind": "trials", "name": "M", "expr": "meanof(n, randexp(1))", "trials": 2000, "seed": 1}. Outputs: M_mean, M_sd, M_skew, M_kurtosis, M_median, M_min, M_max.
- plot: {"op": "plot", "source": "f_3"} → a curve against the variable the formula uses (or x: "theta", from/to); several formulas: "source": ["f_3", "f_4"]; a system: {"source": "sys_5", "x": "t", "y": "S,I,R"} or a trajectory {"x": "x", "y": "y"}; trials: a histogram.
- experiment on a formula/system/trials: {"op": "experiment", "target": "f_3", "variable": {"param": "theta", "values": [15, 30, 45, 60, 75]}, "hypothesis": {"text": "45° goes farthest", "expect": [{"value": 45, "metric": "range", "op": ">=", "than": 30}]}}. Metrics are the target's outputs (a formula's metric is its name). Other variables are frozen at their current values so the experiment reproduces.
- A prediction is a claim; verify_claim with the experiment settles it.
${LANGUAGE_DOC}`;

