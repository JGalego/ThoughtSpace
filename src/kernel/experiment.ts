// Deterministic experiment runner. An experiment varies one network parameter over a set
// of values, holds everything else constant, trains from a fresh seeded initialisation
// for each seed, and measures outcomes. Same spec ⇒ same results ⇒ same hash.

import { hashString, initWeights, round4, train, type Activation, type Point } from './nn';

export type Metric = 'success_rate' | 'mean_final_loss' | 'best_accuracy' | 'mean_accuracy' | 'mean_converged_at' | 'mean_grad_norm';
export const METRICS: Metric[] = ['success_rate', 'mean_final_loss', 'best_accuracy', 'mean_accuracy', 'mean_converged_at', 'mean_grad_norm'];

export interface Expectation {
  /** which variable value this expectation is about (JSON-equal); omit = every value */
  value?: unknown;
  metric: Metric;
  op: '<' | '<=' | '>' | '>=' | '==';
  /** a fixed number to compare against … */
  threshold?: number;
  /** … or another value of the variable: "hidden [2] has higher mean_accuracy than []" */
  than?: unknown;
}

export interface ExperimentSpec {
  target: string;
  hypothesis: { text: string; expect: Expectation[] };
  variable: { param: 'hidden' | 'activation' | 'learningRate' | 'epochs'; values: unknown[] };
  baseline: { hidden: number[]; activation: Activation; learningRate: number; epochs: number };
  seeds: number[];
  data: Point[];
  datasetId: string;
}

export interface RunResult {
  seed: number;
  finalLoss: number;
  accuracy: number;
  convergedAt: number | null;
  gradNorm: number;
  loss: number[]; // downsampled to ≤ 40 points
}

export interface ValueResult {
  value: unknown;
  runs: RunResult[];
  summary: Record<Metric, number | null>;
}

export interface Verdict {
  expectation: Expectation;
  holds: boolean;
  observed: (number | null)[];
}

export interface ExperimentOutcome {
  results: ValueResult[];
  verdicts: Verdict[];
  supported: boolean | null;
  conclusion: string;
  hash: string;
  constants: Record<string, unknown>;
  measures: string[];
}

export function runExperiment(spec: ExperimentSpec): ExperimentOutcome {
  const results: ValueResult[] = spec.variable.values.map((value) => {
    const cfg = { ...spec.baseline, [spec.variable.param]: value } as ExperimentSpec['baseline'];
    const layers = [2, ...cfg.hidden, 1];
    const runs: RunResult[] = spec.seeds.map((seed) => {
      const w = initWeights(layers, seed);
      const r = train({ layers, activation: cfg.activation, ...w }, spec.data, { learningRate: cfg.learningRate, epochs: cfg.epochs });
      const every = Math.max(1, Math.ceil(r.loss.length / 40));
      return {
        seed,
        finalLoss: r.finalLoss,
        accuracy: r.finalAccuracy,
        convergedAt: r.convergedAt,
        gradNorm: r.finalGradNorm,
        loss: r.loss.filter((_, i) => i % every === 0),
      };
    });
    return { value, runs, summary: summarize(runs) };
  });

  const verdicts: Verdict[] = spec.hypothesis.expect.map((e) => {
    const rel = results.filter((r) => e.value === undefined || JSON.stringify(r.value) === JSON.stringify(e.value));
    const observed = rel.map((r) => r.summary[e.metric]);
    const other = e.than !== undefined ? results.find((r) => JSON.stringify(r.value) === JSON.stringify(e.than))?.summary[e.metric] : e.threshold;
    const holds = rel.length > 0 && other !== undefined && other !== null && observed.every((v) => v !== null && compare(v, e.op, other));
    return { expectation: e, holds, observed };
  });
  // no testable expectation ⇒ inconclusive (null), never evidence either way
  const supported = verdicts.length > 0 ? verdicts.every((v) => v.holds) : null;

  const constants: Record<string, unknown> = {
    dataset: spec.datasetId,
    optimizer: 'full-batch gradient descent, BCE loss',
    output: 'sigmoid',
    seeds: spec.seeds,
  };
  for (const [k, v] of Object.entries(spec.baseline)) if (k !== spec.variable.param) constants[k] = v;

  const hash = hashString(JSON.stringify(results.map((r) => [r.value, r.runs.map((x) => [x.seed, x.finalLoss, x.accuracy, x.convergedAt])])));
  return {
    results,
    verdicts,
    supported,
    conclusion: conclude(spec, results, verdicts, supported),
    hash,
    constants,
    measures: ['final loss', 'accuracy', 'convergence epoch', 'gradient norm'],
  };
}

function summarize(runs: RunResult[]): Record<Metric, number | null> {
  const n = runs.length || 1;
  const conv = runs.filter((r) => r.convergedAt !== null);
  return {
    success_rate: round4(conv.length / n),
    mean_final_loss: round4(runs.reduce((s, r) => s + r.finalLoss, 0) / n),
    best_accuracy: Math.max(0, ...runs.map((r) => r.accuracy)),
    mean_accuracy: round4(runs.reduce((s, r) => s + r.accuracy, 0) / n),
    mean_converged_at: conv.length ? Math.round(conv.reduce((s, r) => s + (r.convergedAt as number), 0) / conv.length) : null,
    mean_grad_norm: round4(runs.reduce((s, r) => s + r.gradNorm, 0) / n),
  };
}

function compare(v: number, op: Expectation['op'], t: number): boolean {
  switch (op) {
    case '<':
      return v < t;
    case '<=':
      return v <= t;
    case '>':
      return v > t;
    case '>=':
      return v >= t;
    case '==':
      return Math.abs(v - t) < 1e-9;
  }
}

export function formatValue(v: unknown): string {
  if (Array.isArray(v)) return v.length === 0 ? 'no hidden layer' : `hidden [${v.join(', ')}]`;
  return String(v);
}

function conclude(spec: ExperimentSpec, results: ValueResult[], verdicts: Verdict[], supported: boolean | null): string {
  const parts = results.map(
    (r) => `${formatValue(r.value)}: ${Math.round((r.summary.success_rate ?? 0) * spec.seeds.length)}/${spec.seeds.length} seeds converged, best accuracy ${Math.round((r.summary.best_accuracy ?? 0) * 100)}%`,
  );
  const verdict = verdicts.length ? (supported ? 'Hypothesis supported.' : 'Hypothesis not supported.') : 'Inconclusive: no testable expectation was given.';
  return `${parts.join('; ')}. ${verdict}`;
}

/** The first value (in the given order) whose success rate is > 0 — "the smallest change that works". */
export function smallestWorking(outcome: ExperimentOutcome): { value: unknown; seed: number } | null {
  for (const r of outcome.results) {
    const ok = r.runs.find((x) => x.convergedAt !== null);
    if (ok) return { value: r.value, seed: ok.seed };
  }
  return null;
}
