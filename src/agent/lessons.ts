// Open lessons for the offline planner. Two layers:
//  - generic building blocks that work for any subject: type "y = a*x^2 + b" and get
//    sliders, a live formula and its curve; "dN/dt = r*N" for a system; "X ~ rand()" for
//    random trials; then plot / test a prediction / what if / why on whatever is there;
//  - a few ready-made lesson starters (physics, epidemics, Fourier, statistics,
//    economics), built from exactly the same primitives, that end in an open prediction.
// Everything goes through the same typed operations a language model would emit.

import type { AgentHost } from './host';
import {
  checkExpr,
  fmt,
  isCalc,
  measure,
  networks,
  providedNames,
  relationsFrom,
  relationsTo,
  variablesBehind,
  type ObjectId,
  type Operation,
  type TSObject,
  type Workspace,
} from '../kernel';

/** starters shown on an empty canvas */
export const LESSON_PROMPTS = [
  'Lesson: which angle throws a ball furthest?',
  'Lesson: how many people must be vaccinated to stop an epidemic?',
  'Lesson: can sine waves build a square wave?',
  'Lesson: why do averages make bell curves?',
  'Lesson: who really pays a tax?',
];

type Handler = (raw: string, t: string, h: AgentHost) => boolean;

/** try the open-lesson vocabulary; true when handled */
export function openLesson(raw: string, h: AgentHost): boolean {
  const t = raw.toLowerCase().trim();
  return HANDLERS.some((f) => f(raw.trim(), t, h));
}

// ------------------------------------------------------------------ helpers

const ws = (h: AgentHost) => h.kernel.state();
const visible = (w: Workspace) => Object.values(w.objects).filter((o) => !o.visual.hidden);
const measurable = (o: TSObject | undefined) => !!o && ['formula', 'system', 'trials'].includes(o.kind);
const idNum = (id: string) => Number(id.split('_').pop()) || 0;

function apply(h: AgentHost, ops: Operation[], summary: string) {
  const r = h.apply(ops, summary);
  if (!r.ok) h.say(`That didn't validate: ${r.errors.join('; ')}`);
  return r;
}

/** the calc object "this" refers to: the selection (or what it points at), else the latest one */
function target(h: AgentHost, pred: (o: TSObject) => boolean = measurable): TSObject | undefined {
  const w = ws(h);
  for (const id of h.selection()) {
    const o = w.objects[id];
    if (!o) continue;
    if (pred(o)) return o;
    const via = [
      ...(o.kind === 'claim' ? (o.state.about as string[]) : []),
      ...(o.kind === 'experiment' ? [o.state.target] : []),
      ...(o.kind === 'graph' ? relationsFrom(w, o.id, 'visualizes').map((r) => r.to) : []),
      ...(o.kind === 'variable' ? relationsFrom(w, o.id, 'feeds_into').map((r) => r.to) : []),
    ]
      .map((x) => w.objects[x])
      .find((x) => x && pred(x));
    if (via) return via;
  }
  return visible(w)
    .filter(pred)
    .sort((a, b) => idNum(b.id) - idNum(a.id))[0];
}

/** is the conversation about open-lesson objects rather than neural networks? */
function calcContext(h: AgentHost): boolean {
  const w = ws(h);
  const sel = h.selection().map((id) => w.objects[id]).filter(Boolean);
  if (sel.some((o) => isCalc(o) || (o.kind === 'claim' && (o.state.about as string[]).some((a) => isCalc(w.objects[a]))) || (o.kind === 'experiment' && o.state.mode === 'calc') || (o.kind === 'graph' && ['curve', 'series', 'histogram'].includes(o.params.mode as string))))
    return true;
  if (sel.some((o) => ['neural_network', 'dataset', 'simulation', 'glyph'].includes(o.kind))) return false;
  return visible(w).some(isCalc) && !networks(w).some((n) => !n.visual.hidden);
}

/** everything downstream of an object: what it feeds, and the plots of those */
function downstream(w: Workspace, id: ObjectId): ObjectId[] {
  const out = new Set<ObjectId>([id]);
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const r of relationsFrom(w, cur, 'feeds_into')) if (!out.has(r.to) && isCalc(w.objects[r.to])) out.add(r.to), queue.push(r.to);
    for (const r of relationsTo(w, cur, 'visualizes')) if (!out.has(r.from)) out.add(r.from);
  }
  return [...out].filter((x) => !w.objects[x].visual.hidden);
}

/** round to a friendly number of significant figures */
const nice = (x: number) => +x.toPrecision(3);

/** 2–5 friendly test values across a slider's range, always including `must` */
function spread(v: TSObject, must?: number): number[] {
  const lo = Number(v.params.min);
  const hi = Number(v.params.max);
  const step = Number(v.params.step) || 0;
  const snap = (x: number) => nice(step > 0 ? Math.round(x / step) * step : x);
  if (must !== undefined) {
    const d = Math.max(step, nice((hi - lo) / 18) || 1);
    const around = [-2, -1, 0, 1, 2].map((k) => snap(must + k * d)).filter((x) => x >= lo && x <= hi);
    return [...new Set(around.length >= 3 ? around : [lo, must, hi].map(snap))].sort((a, b) => a - b);
  }
  return [...new Set([0, 0.2, 0.4, 0.6, 0.8].map((f) => snap(lo + f * (hi - lo))))];
}

// ------------------------------------------------------------------ predictions → experiments

interface Plan {
  variable: TSObject;
  values: number[];
  metric: string;
  expect: Record<string, unknown>[];
  reading: string;
}

const UP = /\b(increase[sd]?|grows?|rises?|goes up|bigger|larger|higher|longer|more|greater)\b/;
const DOWN = /\b(decrease[sd]?|shrinks?|falls?|drops?|goes down|smaller|lower|shorter|less|fewer)\b/;
const MAX = /\b(largest|biggest|highest|greatest|max(imum)?|furthest|farthest|longest|most|peaks?|best)\b/;
const MIN = /\b(smallest|lowest|least|min(imum)?|shortest|fewest|worst)\b/;

/**
 * Read a prediction such as "R is largest when theta = 45", "I_max decreases as vacc
 * increases" or "at n = 50, overshoot is below 1" into a controlled experiment.
 */
export function planFor(w: Workspace, o: TSObject, text: string): Plan | string {
  const probe = measure(w, o);
  if (!probe.ok) return `${o.state.name} can't be computed right now: ${probe.error}`;
  const metrics = Object.keys(probe.value);
  const vars = variablesBehind(w, o.id);
  if (!vars.length) return `${o.state.name} doesn't depend on any slider, so there is nothing to vary.`;
  const words = text.match(/[A-Za-z_α-ωΑ-Ω][\w]*/g) ?? [];
  const metric = words.find((x) => metrics.includes(x)) ?? words.map((x) => `${o.state.name}_${x}`).find((x) => metrics.includes(x)) ?? (o.kind === 'trials' ? `${o.state.name}_mean` : metrics[0]);
  const vname = words.find((x) => vars.some((v) => v.state.name === x) && x !== metric);
  const variable = vars.find((v) => v.state.name === vname) ?? vars[0];
  const name = variable.state.name as string;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const at = new RegExp(`\\b${esc}\\s*(?:=|is|of|equals?)\\s*(-?\\d+(?:\\.\\d+)?)`).exec(text);
  const atValue = at ? Number(at[1]) : undefined;
  const below = /(?:\b(?:below|under|less than|smaller than|lower than|at most)|<=?)\s*(-?\d+(?:\.\d+)?)/.exec(text.toLowerCase());
  const above = /(?:\b(?:above|over|more than|greater than|bigger than|higher than|at least)|>=?)\s*(-?\d+(?:\.\d+)?)/.exec(text.toLowerCase());
  const lower = text.toLowerCase();

  if (below || above) {
    const [m, op] = below ? [below, /^(at most|<=)/.test(below[0]) ? '<=' : '<'] : [above!, /^(at least|>=)/.test(above![0]) ? '>=' : '>'];
    const threshold = Number(m[1]);
    // a claim about one value is still shown against the whole range
    const values = [...new Set([...spread(variable), ...(atValue !== undefined ? [atValue] : [])])].sort((x, y) => x - y);
    return {
      variable,
      values,
      metric,
      expect: atValue !== undefined ? [{ value: atValue, metric, op, threshold }] : values.map((value) => ({ value, metric, op, threshold })),
      reading: `${metric} ${op} ${fmt(threshold)} ${atValue !== undefined ? `when ${name} = ${fmt(atValue)}` : `for every ${name} tested`}`,
    };
  }
  if (atValue !== undefined && (MAX.test(lower) || MIN.test(lower))) {
    const values = spread(variable, atValue);
    const op = MAX.test(lower) ? '>=' : '<=';
    return {
      variable,
      values,
      metric,
      expect: values.filter((v) => v !== atValue).map((than) => ({ value: atValue, metric, op, than })),
      reading: `${metric} is ${op === '>=' ? 'largest' : 'smallest'} at ${name} = ${fmt(atValue)} among ${values.map((x) => fmt(x)).join(', ')}`,
    };
  }
  if (UP.test(lower) || DOWN.test(lower)) {
    const values = spread(variable);
    const down = DOWN.test(lower) && !(/\bthe (more|bigger|higher|larger)\b.*\bthe (more|bigger|higher|larger|longer)\b/.test(lower));
    const weak = down ? '<=' : '>=';
    const expect = [
      ...values.slice(1).map((value, i) => ({ value, metric, op: weak, than: values[i] })),
      { value: values[values.length - 1], metric, op: down ? '<' : '>', than: values[0] },
    ];
    return { variable, values, metric, expect, reading: `${metric} ${down ? 'never rises and ends lower' : 'never falls and ends higher'} as ${name} goes ${values.map((x) => fmt(x)).join(' → ')}` };
  }
  return `I couldn't read a testable prediction in “${text}”. Try: “${metric} is largest when ${name} = ${fmt(Number(variable.params.value))}”, “${metric} increases as ${name} increases”, or “when ${name} = ${fmt(Number(variable.params.max))}, ${metric} is below …”.`;
}

function testPrediction(h: AgentHost, claim: TSObject | undefined, text: string, about?: TSObject): boolean {
  const w = ws(h);
  const o = about ?? (claim ? (claim.state.about as string[]).map((a) => w.objects[a]).find(measurable) : undefined) ?? target(h);
  if (!o) {
    h.say('There is nothing to measure yet. Make a formula first, e.g. "y = a*x^2 + b".');
    return true;
  }
  const plan = planFor(w, o, text);
  if (typeof plan === 'string') {
    h.say(plan);
    return true;
  }
  h.status('running experiment…');
  const ops: Operation[] = [];
  let claimRef: string = claim?.id ?? '';
  if (!claim) {
    ops.push({ op: 'claim', text, about: [o.id], ref: 'c' });
    claimRef = '$c';
  }
  ops.push({ op: 'experiment', target: o.id, ref: 'e', variable: { param: plan.variable.state.name, values: plan.values }, hypothesis: { text, expect: plan.expect } });
  if (!claim || claim.state.status === 'unverified') ops.push({ op: 'verify_claim', claim: claimRef, evidence: '$e' });
  const r = apply(h, ops, 'test a prediction');
  if (!r.ok) return true;
  const e = ws(h).objects[r.refs.e];
  h.focus([e.id]);
  h.highlight([e.id]);
  const rows = (e.state.results as { value: number; metrics: Record<string, number> }[]).map((x) => `${fmt(x.value)} → ${fmt(x.metrics[plan.metric], 4)}`).join(', ');
  const consts = Object.entries(e.state.constants as Record<string, number>).map(([k, v]) => `${k} = ${fmt(v)}`);
  h.say(
    `I read the prediction as: ${plan.reading}. Varying ${plan.variable.state.name} and keeping ${consts.join(', ') || 'everything else'} fixed: ${plan.metric} ${rows}. ` +
      `${e.state.supported ? 'The prediction holds.' : 'The prediction fails.'} ${consts.length ? 'Move a slider and ask me to test it again: the answer may change.' : ''}`,
  );
  return true;
}

// ------------------------------------------------------------------ typed mathematics

interface Stmt {
  kind: 'value' | 'formula' | 'rate' | 'init' | 'trials';
  name: string;
  expr: string;
}

const IDENT = '[A-Za-zα-ωΑ-Ω][\\w]*';

function statements(raw: string): Stmt[] | undefined {
  const body = raw.replace(/^(let|define|make|create|set|model|plot|graph)\s+/i, '');
  const parts = body.split(/[;\n]|,\s+(?=[A-Za-zα-ωΑ-Ω][\w]*(?:\(0\))?\s*(?:=|~)|d[A-Za-z]\w*\/dt)/).map((s) => s.trim()).filter(Boolean);
  const out: Stmt[] = [];
  for (const p of parts) {
    let m: RegExpExecArray | null;
    if ((m = new RegExp(`^d(${IDENT})\\s*/\\s*dt\\s*=\\s*(.+)$`).exec(p))) out.push({ kind: 'rate', name: m[1], expr: m[2] });
    else if ((m = new RegExp(`^(${IDENT})\\s*\\(\\s*0\\s*\\)\\s*=\\s*(.+)$`).exec(p))) out.push({ kind: 'init', name: m[1], expr: m[2] });
    else if ((m = new RegExp(`^(${IDENT})\\s*~\\s*(.+)$`).exec(p))) out.push({ kind: 'trials', name: m[1], expr: m[2] });
    else if ((m = new RegExp(`^(${IDENT})\\s*=\\s*(.+)$`).exec(p))) out.push({ kind: /^-?[\d.]+(e-?\d+)?$/.test(m[2].trim()) ? 'value' : 'formula', name: m[1], expr: m[2] });
    else return undefined;
  }
  return out.length ? out : undefined;
}

const NN_PARAMS = new Set(['lr', 'epochs', 'seed', 'hidden', 'activation']);

const typedMath: Handler = (raw, _t, h) => {
  const st = statements(raw);
  if (!st) return false;
  const w = ws(h);
  if (st.every((s) => s.kind === 'value' && NN_PARAMS.has(s.name)) && networks(w).length) return false;

  // parse everything first, so a typo is reported before anything is created
  const names = new Map<string, string[]>();
  try {
    for (const s of st) names.set(`${s.kind}:${s.name}`, s.kind === 'value' ? [] : checkExpr(s.expr).names);
  } catch (e) {
    h.say(`I couldn't read that: ${(e as Error).message}`);
    return true;
  }
  const existing = new Map<string, TSObject>();
  for (const o of visible(w)) if (isCalc(o)) for (const n of providedNames(o)) existing.set(n, o);

  // setting an existing slider: "theta = 30"
  const setOps: Operation[] = [];
  const rest: Stmt[] = [];
  for (const s of st) {
    const v = existing.get(s.name);
    if (s.kind === 'value' && v?.kind === 'variable') setOps.push({ op: 'set_parameter', id: v.id, param: 'value', value: Number(s.expr) });
    else rest.push(s);
  }

  const rates = rest.filter((s) => s.kind === 'rate');
  const locals = new Set(['t', ...rates.map((s) => s.name)]);
  const defined = new Set([...existing.keys(), ...rest.filter((s) => s.kind !== 'rate' && s.kind !== 'init').map((s) => s.name), ...locals]);
  const missing = new Set<string>();
  for (const s of rest) for (const n of names.get(`${s.kind}:${s.name}`) ?? []) if (!defined.has(n)) missing.add(n);

  const ops: Operation[] = [...setOps];
  const sliderFor = (name: string, value = 1): Operation => {
    const range = name === 't' ? [0, 10] : name === 'n' || name === 'N' ? [1, 50] : value > 0 ? [0, Math.max(10, nice(value * 3))] : [-10, 10];
    return { op: 'create_object', kind: 'variable', name, value, min: range[0], max: range[1], step: name === 'n' ? 1 : undefined };
  };
  for (const s of rest.filter((x) => x.kind === 'value')) ops.push(sliderFor(s.name, Number(s.expr)));
  for (const n of missing) ops.push(sliderFor(n));

  // formulas in dependency order
  const formulas = rest.filter((s) => s.kind === 'formula');
  const done = new Set<string>();
  const madeRefs: string[] = [];
  while (done.size < formulas.length) {
    const next = formulas.find((f) => !done.has(f.name) && (names.get(`formula:${f.name}`) ?? []).every((n) => !formulas.some((g) => g.name === n && g !== f) || done.has(n)));
    if (!next) {
      h.say('Those formulas refer to each other in a circle, so none of them can be computed first.');
      return true;
    }
    done.add(next.name);
    ops.push({ op: 'create_object', kind: 'formula', name: next.name, expr: next.expr, ref: `f_${next.name}` });
    madeRefs.push(`f_${next.name}`);
  }
  if (rates.length) {
    const inits = new Map(rest.filter((s) => s.kind === 'init').map((s) => [s.name, s.expr]));
    ops.push({ op: 'create_object', kind: 'system', name: rates.length === 1 ? `${rates[0].name}_model` : 'model', vars: rates.map((r) => ({ name: r.name, init: inits.get(r.name) ?? '1', rate: r.expr })), t_max: 20, ref: 'sys' });
    madeRefs.push('sys');
  }
  for (const s of rest.filter((x) => x.kind === 'trials')) {
    ops.push({ op: 'create_object', kind: 'trials', name: s.name, expr: s.expr, trials: 2000, ref: `t_${s.name}` });
    madeRefs.push(`t_${s.name}`);
  }
  // show the last thing made: a curve, a time series, a histogram
  const last = madeRefs[madeRefs.length - 1];
  if (last) ops.push({ op: 'plot', source: `$${last}`, ref: 'p' });

  let r = apply(h, ops, 'build from typed mathematics');
  if (!r.ok && ops[ops.length - 1].op === 'plot') r = apply(h, ops.slice(0, -1), 'build from typed mathematics'); // e.g. a constant formula has no x-axis
  if (!r.ok) return true;
  h.focus(r.created.length ? r.created : setOps.map((o) => o.id as string));
  const made = [...missing, ...rest.filter((x) => x.kind === 'value').map((x) => x.name)];
  h.say(
    [
      setOps.length ? `Set ${setOps.map((o) => `${ws(h).objects[o.id as string].state.name} = ${fmt(Number(o.value))}`).join(', ')}.` : '',
      made.length ? `Made slider${made.length > 1 ? 's' : ''} for ${made.join(', ')} (set ${made.length > 1 ? 'them' : 'it'} to anything; drag to explore).` : '',
      formulas.length ? `${formulas.map((f) => f.name).join(', ')} ${formulas.length > 1 ? 'are' : 'is'} live: ${formulas.length > 1 ? 'they recompute' : 'it recomputes'} whenever a slider moves.` : '',
      rates.length ? `The system integrates ${rates.map((x) => `d${x.name}/dt`).join(', ')} over time (start values: say "${rates[0].name}(0) = …").` : '',
      r.refs.p ? 'Drag along the curve, or write a prediction and ask me to test it.' : '',
    ]
      .filter(Boolean)
      .join(' '),
  );
  return true;
};

// ------------------------------------------------------------------ generic verbs

const plot: Handler = (_raw, t, h) => {
  if (!/\b(plot|graph|chart|histogram|visuali[sz]e|draw (it|this)|show (it|me))\b/.test(t) || !calcContext(h)) return false;
  const o = target(h);
  if (!o) return false;
  const r = apply(h, [{ op: 'plot', source: o.id, ref: 'p' }], 'plot');
  if (r.ok) {
    h.focus([r.refs.p]);
    h.say(o.kind === 'formula' ? 'Here it is. Drag along the curve to move the slider; the dot is where you are now.' : o.kind === 'system' ? 'Here is how it unfolds over time.' : 'Here is the spread of outcomes; the orange curve is a normal distribution with the same mean and spread.');
  }
  return true;
};

const test: Handler = (raw, t, h) => {
  if (!/\b(test|experiment|verify|check|predict(ion)?|i (think|bet|guess))\b/.test(t)) return false;
  const w = ws(h);
  const claim = h.selection().map((id) => w.objects[id]).find((o) => o?.kind === 'claim');
  if (claim && (claim.state.about as string[]).some((a) => isCalc(w.objects[a]))) return testPrediction(h, claim, claim.state.text);
  if (!calcContext(h)) return false;
  // "test: R is largest when theta = 45" — the prediction is in the request itself
  const inline = raw.replace(/^.*?\b(test|check|verify|predict(ion)?|i (think|bet|guess))\b(\s+(that|whether|if))?\s*:?\s*/i, '').trim();
  if (inline.length > 6 && /\b(when|as|at|below|above|under|over|than|increase|decrease|largest|smallest|grow|shrink|more|less)\b/i.test(inline)) return testPrediction(h, undefined, inline.charAt(0).toUpperCase() + inline.slice(1));
  const open = visible(w).find((o) => o.kind === 'claim' && o.state.status === 'unverified' && (o.state.about as string[]).some((a) => isCalc(w.objects[a])));
  if (open) return testPrediction(h, open, open.state.text);
  h.say('Write the prediction and I will turn it into an experiment, e.g. “test: R is largest when theta = 45” or “test: I_max decreases as vacc increases”.');
  return true;
};

const whatIf: Handler = (raw, t, h) => {
  if (!/\bwhat if\b|\bbranch\b|\bsuppose\b|\bimagine\b/.test(t)) return false;
  const w = ws(h);
  const sliders = visible(w).filter((o) => o.kind === 'variable');
  const m = new RegExp(`\\b(${IDENT})\\s*(?:=|were|was|is|to|becomes?)\\s*(-?\\d+(?:\\.\\d+)?)`).exec(raw);
  const v = m && sliders.find((s) => s.state.name === m[1]);
  if (!v) {
    if (!calcContext(h)) return false;
    h.say(`Tell me which slider to change in the alternative world, e.g. “what if ${sliders[0]?.state.name ?? 'k'} = ${sliders[0] ? fmt(Number(sliders[0].params.max)) : 2}?”`);
    return true;
  }
  const value = Number(m![2]);
  const ids = downstream(w, v.id);
  const main = ids.map((id) => w.objects[id]).find((o) => measurable(o) && o.kind !== 'formula') ?? ids.map((id) => w.objects[id]).find(measurable);
  const assumption = `${v.state.name} = ${fmt(value)}`;
  const r = apply(h, [{ op: 'branch', ids, assumption, direction: 'below', changes: [{ id: v.id, param: 'value', value }] }], `what if ${assumption}`);
  if (!r.ok) return true;
  const after = ws(h);
  const copyOf = (id: ObjectId) => Object.values(after.relations).filter((x) => x.type === 'branched_from' && x.to === id).map((x) => x.from).sort((a, b) => idNum(b) - idNum(a))[0];
  let msg = `Branched into an alternative where ${assumption} (was ${fmt(Number(v.params.value))}); the original is untouched.`;
  if (main && copyOf(main.id)) {
    const c = apply(h, [{ op: 'compare', a: main.id, b: copyOf(main.id), ref: 'cmp' }], 'compare the alternatives');
    const a = measure(after, main);
    const b = measure(after, after.objects[copyOf(main.id)]);
    if (c.ok && a.ok && b.ok) {
      const key = Object.keys(a.value)[0];
      msg += ` ${key}: ${fmt(a.value[key], 4)} → ${fmt(b.value[key], 4)}. Differences are highlighted in the comparison.`;
      h.focus([...r.created, c.refs.cmp]);
    }
  } else h.focus(r.created);
  h.say(msg);
  return true;
};

const why: Handler = (_raw, t, h) => {
  if (!/\bwhy\b|\bexplain\b|\bhow does\b|\bwhat (drives|matters|controls)\b|\bsensitiv/.test(t) || !calcContext(h)) return false;
  const w = ws(h);
  // without a selection, "why?" is about whatever the class tested last
  const lastExp = visible(w)
    .filter((x) => x.kind === 'experiment' && x.state.mode === 'calc' && w.objects[x.state.target])
    .sort((a, b) => idNum(b.id) - idNum(a.id))[0];
  const o = h.selection().length || !lastExp ? target(h) : w.objects[lastExp.state.target];
  if (!o) return false;
  const base = measure(w, o);
  if (!base.ok) {
    h.say(`${o.state.name} can't be computed: ${base.error}`);
    return true;
  }
  const tested = lastExp?.state.target === o.id ? (lastExp.state.focus as string) : undefined;
  const key = tested && tested in base.value ? tested : o.kind === 'formula' ? (o.state.name as string) : o.kind === 'trials' ? `${o.state.name}_mean` : Object.keys(base.value).find((k) => k.endsWith('_max')) ?? Object.keys(base.value)[0];
  const vars = variablesBehind(w, o.id);
  const effects = vars
    .map((v) => {
      const span = (Number(v.params.max) - Number(v.params.min)) / 10 || 1;
      const up = measure(w, o, { [v.state.name]: Number(v.params.value) + span });
      return { v, span, delta: up.ok ? up.value[key] - base.value[key] : NaN };
    })
    .filter((e) => Number.isFinite(e.delta))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const parts = effects.map((e) => `${e.v.state.name} +${fmt(e.span)} → ${key} ${e.delta >= 0 ? '+' : ''}${fmt(e.delta, 3)}`);
  const expr = o.kind === 'formula' || o.kind === 'trials' ? ` It is computed as ${o.state.name} = ${o.state.expr}.` : '';
  h.highlight(effects.slice(0, 1).map((e) => e.v.id), 'the biggest lever right now');
  h.say(
    `${key} is ${fmt(base.value[key], 4)} right now.${expr} ${vars.length ? `It depends on ${vars.map((v) => `${v.state.name} = ${fmt(Number(v.params.value))}`).join(', ')}. Nudging each slider by a tenth of its range: ${parts.join('; ')}.` : ''} ${effects[0] ? `So at this point ${effects[0].v.state.name} matters most — but that can change elsewhere: try moving it and asking again.` : ''}`,
  );
  return true;
};

// ------------------------------------------------------------------ ready-made starters

interface Lesson {
  match: RegExp;
  build(): Operation[];
  say: string;
}

const LESSONS: Lesson[] = [
  {
    match: /projectile|trajector|launch angle|throw(s|ing)? a ball|cannon|which angle|ball furthest/,
    build: () => [
      { op: 'create_object', kind: 'text', ref: 'q', label: 'Question', state: { text: 'Which launch angle throws a ball furthest?\n\nPredict first. Then move the sliders, drag along the curve, and test your prediction. Does air drag change the answer?' } },
      { op: 'create_object', kind: 'variable', name: 'theta', value: 30, min: 0, max: 90, step: 1, unit: '°', label: 'Launch angle' },
      { op: 'create_object', kind: 'variable', name: 'v0', value: 20, min: 1, max: 40, step: 0.5, unit: 'm/s', label: 'Launch speed' },
      { op: 'create_object', kind: 'variable', name: 'g', value: 9.81, min: 1, max: 25, step: 0.01, unit: 'm/s²', label: 'Gravity' },
      { op: 'create_object', kind: 'variable', name: 'k', value: 0, min: 0, max: 0.1, step: 0.005, label: 'Air drag', description: 'drag per unit speed' },
      { op: 'create_object', kind: 'formula', name: 'R', expr: 'v0^2*sin(2*rad(theta))/g', unit: 'm', label: 'Range (no air)', ref: 'R' },
      { op: 'plot', source: '$R', label: 'Range vs angle (no air)' },
      {
        op: 'create_object',
        kind: 'system',
        name: 'ball',
        label: 'Flight (with drag k)',
        vars: [
          { name: 'x', init: '0', rate: 'vx' },
          { name: 'y', init: '0', rate: 'vy' },
          { name: 'vx', init: 'v0*cos(rad(theta))', rate: '-k*speed*vx' },
          { name: 'vy', init: 'v0*sin(rad(theta))', rate: '-g - k*speed*vy' },
        ],
        helpers: [{ name: 'speed', expr: 'hypot(vx, vy)' }],
        stop: 'y < 0',
        t_max: 20,
        dt: 0.01,
        ref: 'ball',
      },
      { op: 'plot', source: '$ball', x: 'x', y: 'y', label: 'Path of the ball' },
      { op: 'claim', text: 'The ball lands furthest (largest x_end) when theta = 45.', about: ['$ball'], ref: 'c' },
    ],
    say: 'A projectile lesson: sliders for angle, speed, gravity and air drag; the textbook range formula and its curve; a simulated flight that includes drag; and an open prediction. Drag θ, or drag along the curve. Then select the prediction and “Test it” — and try again after turning up the drag.',
  },
  {
    match: /epidemic|pandemic|vaccin|outbreak|disease|sir model|herd immunity|infection/,
    build: () => [
      { op: 'create_object', kind: 'text', ref: 'q', label: 'Question', state: { text: 'How does a disease spread through a population — and how many people must be vaccinated to stop it?\n\nS = still susceptible, I = infected, R = recovered or immune (fractions of everyone).' } },
      { op: 'create_object', kind: 'variable', name: 'R0', value: 2.5, min: 0.5, max: 8, step: 0.1, label: 'R₀: people each case infects' },
      { op: 'create_object', kind: 'variable', name: 'days', value: 10, min: 2, max: 21, step: 1, unit: 'days', label: 'Days contagious' },
      { op: 'create_object', kind: 'variable', name: 'vacc', value: 0, min: 0, max: 0.95, step: 0.05, label: 'Fraction vaccinated' },
      {
        op: 'create_object',
        kind: 'system',
        name: 'outbreak',
        label: 'Outbreak (SIR model)',
        helpers: [
          { name: 'beta', expr: 'R0/days' },
          { name: 'gam', expr: '1/days' },
        ],
        vars: [
          { name: 'S', init: '(1 - vacc)*0.999', rate: '-beta*S*I' },
          { name: 'I', init: '0.001', rate: 'beta*S*I - gam*I' },
          { name: 'R', init: 'vacc*0.999', rate: 'gam*I' },
        ],
        t_max: 365,
        dt: 0.5,
        ref: 'sir',
      },
      { op: 'plot', source: '$sir', y: 'S,I,R', label: 'Over a year' },
      { op: 'create_object', kind: 'formula', name: 'herd', expr: '(1 - 1/R0)*100', unit: '%', label: 'Herd-immunity threshold' },
      { op: 'claim', text: 'Vaccinating 60% of people is enough: when vacc = 0.6, I_max stays below 0.01.', about: ['$sir'], ref: 'c' },
    ],
    say: 'An epidemic lesson: the SIR model as three rates of change, sliders for R₀, contagious days and vaccination, the curves over a year, and the herd-immunity threshold. Test the prediction — then raise R₀ (measles is about 15) and test it again.',
  },
  {
    match: /fourier|square wave|gibbs|sine waves?.*(build|make|add)|harmonics/,
    build: () => [
      { op: 'create_object', kind: 'text', ref: 'q', label: 'Question', state: { text: 'Can smooth sine waves add up to a square wave with sharp corners?\n\nAdd terms with the n slider and watch the corner. Does the bump near the jump ever go away?' } },
      { op: 'create_object', kind: 'variable', name: 'n', value: 3, min: 1, max: 50, step: 1, label: 'Number of sine terms' },
      { op: 'create_object', kind: 'variable', name: 'x', value: 0.3, min: -3.14, max: 3.14, step: 0.01 },
      { op: 'create_object', kind: 'formula', name: 'square', expr: 'sign(sin(x))', label: 'Square wave' },
      { op: 'create_object', kind: 'formula', name: 'S', expr: '4/pi * sum(k, 1, n, sin((2k-1)*x)/(2k-1))', label: 'Sum of n sines', ref: 'S' },
      { op: 'plot', source: ['square', '$S'], label: 'Square wave vs sum of sines' },
      { op: 'create_object', kind: 'formula', name: 'overshoot', expr: '(maxover(x, 0.0001, pi/2, S, 800) - 1)/2*100', unit: '%', label: 'Overshoot at the jump', description: 'how far past the corner, as % of the jump', ref: 'o' },
      { op: 'claim', text: 'With enough terms the bump disappears: when n = 50, overshoot is below 1.', about: ['$o'], ref: 'c' },
    ],
    say: 'A Fourier lesson: a square wave, the sum of the first n odd sine harmonics, both on one plot, and a live measure of the overshoot at the jump. Drag n and watch the corner sharpen — then test whether the bump really disappears.',
  },
  {
    match: /central limit|\bclt\b|bell curve|averages? (make|of)|dice|normal distribution/,
    build: () => [
      { op: 'create_object', kind: 'text', ref: 'q', label: 'Question', state: { text: 'One die is flat: every face is equally likely. What does the AVERAGE of many dice look like?\n\nChange n, re-roll with 🎲, and watch the shape.' } },
      { op: 'create_object', kind: 'variable', name: 'n', value: 1, min: 1, max: 50, step: 1, label: 'Dice per average' },
      { op: 'create_object', kind: 'trials', name: 'M', expr: 'meanof(n, randint(1, 6))', trials: 3000, bins: 30, label: 'Average of n dice', ref: 'M' },
      { op: 'plot', source: '$M', label: 'Distribution of the average' },
      { op: 'create_object', kind: 'formula', name: 'sd_theory', expr: 'sqrt(35/12/n)', label: 'Predicted spread (σ/√n)' },
      { op: 'claim', text: 'Averaging more dice narrows the spread: M_sd decreases as n increases.', about: ['$M'], ref: 'c' },
    ],
    say: 'A statistics lesson: 3000 simulated averages of n dice, their histogram with a matching normal curve, and the theoretical spread σ/√n. Slide n from 1 upwards and watch the flat distribution become a bell. Every roll is seeded, so the class sees the same thing — press 🎲 for a fresh sample.',
  },
  {
    match: /\btax(es)?\b|supply and demand|incidence|market price/,
    build: () => [
      { op: 'create_object', kind: 'text', ref: 'q', label: 'Question', state: { text: 'The government charges sellers a tax on every unit sold. Who really pays it — sellers or buyers?\n\nDemand: price buyers accept; supply: price sellers need. Change the slopes and the tax.' } },
      { op: 'create_object', kind: 'variable', name: 'tax', value: 10, min: 0, max: 40, step: 1, unit: '€', label: 'Tax per unit' },
      { op: 'create_object', kind: 'variable', name: 'b', value: 1, min: 0.1, max: 5, step: 0.1, label: 'Demand slope (how picky buyers are)' },
      { op: 'create_object', kind: 'variable', name: 'd', value: 1, min: 0.1, max: 5, step: 0.1, label: 'Supply slope (how picky sellers are)' },
      { op: 'create_object', kind: 'variable', name: 'a', value: 100, min: 50, max: 150, label: 'Most anyone would pay', unit: '€' },
      { op: 'create_object', kind: 'variable', name: 'c', value: 10, min: 0, max: 50, label: 'Lowest price to produce', unit: '€' },
      { op: 'create_object', kind: 'variable', name: 'q', value: 40, min: 0, max: 100, label: 'Quantity' },
      { op: 'create_object', kind: 'formula', name: 'demand', expr: 'a - b*q', unit: '€' },
      { op: 'create_object', kind: 'formula', name: 'supply', expr: 'c + d*q', unit: '€' },
      { op: 'create_object', kind: 'formula', name: 'supply_taxed', expr: 'c + d*q + tax', unit: '€', label: 'Supply + tax' },
      { op: 'plot', source: ['demand', 'supply', 'supply_taxed'], x: 'q', label: 'The market' },
      { op: 'create_object', kind: 'formula', name: 'P_buyer', expr: 'a - b*(a - c - tax)/(b + d)', unit: '€', label: 'Price buyers pay (with tax)' },
      { op: 'create_object', kind: 'formula', name: 'P_before', expr: 'a - b*(a - c)/(b + d)', unit: '€', label: 'Price before the tax' },
      { op: 'create_object', kind: 'formula', name: 'buyer_share', expr: '(P_buyer - P_before)/tax*100', unit: '%', label: "Buyers' share of the tax", ref: 's' },
      { op: 'claim', text: 'Sellers are charged the tax, so they pay it: buyer_share is below 1 when tax = 10.', about: ['$s'], ref: 'c' },
    ],
    say: 'An economics lesson: demand and supply curves, the supply curve shifted up by the tax, and live formulas for the price buyers pay and their share of the tax. The prediction is the common intuition — test it, then change the slopes b and d and see who ends up paying.',
  },
];

const lesson: Handler = (_raw, t, h) => {
  const l = LESSONS.find((x) => x.match.test(t));
  if (!l || /\bxor\b/.test(t)) return false;
  h.status('building the lesson…');
  const r = apply(h, l.build(), 'build a lesson');
  if (!r.ok) return true;
  h.focus(r.created);
  if (r.refs.c) h.highlight([r.refs.c], 'your prediction: test it');
  h.say(l.say);
  return true;
};

const HANDLERS: Handler[] = [typedMath, lesson, test, whatIf, why, plot];
