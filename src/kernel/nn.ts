// Deterministic numerical executor for small multilayer perceptrons.
// Everything here is pure and seeded: the same inputs always give the same outputs.

export type Activation = 'sigmoid' | 'tanh' | 'relu' | 'linear' | 'step';
export const ACTIVATIONS: Activation[] = ['sigmoid', 'tanh', 'relu', 'linear', 'step'];

/** W[l][j][i]: weight from unit i of layer l to unit j of layer l+1 */
export type Weights = number[][][];
export type Biases = number[][];

export interface NetParams {
  layers: number[]; // e.g. [2, 1] or [2, 2, 1]
  weights: Weights;
  biases: Biases;
  activation: Activation; // hidden layers; the output unit is always sigmoid
}

export interface Point {
  x: [number, number];
  y: 0 | 1;
}

// ------------------------------------------------------------------ PRNG

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------ activations

export function act(a: Activation, z: number): number {
  switch (a) {
    case 'sigmoid':
      return 1 / (1 + Math.exp(-z));
    case 'tanh':
      return Math.tanh(z);
    case 'relu':
      return z > 0 ? z : 0;
    case 'linear':
      return z;
    case 'step':
      return z >= 0 ? 1 : 0;
  }
}

/** derivative expressed in terms of pre-activation z */
export function dact(a: Activation, z: number): number {
  switch (a) {
    case 'sigmoid': {
      const s = 1 / (1 + Math.exp(-z));
      return s * (1 - s);
    }
    case 'tanh': {
      const t = Math.tanh(z);
      return 1 - t * t;
    }
    case 'relu':
      return z > 0 ? 1 : 0;
    case 'linear':
      return 1;
    case 'step':
      return 0; // not differentiable: gradient descent cannot move it
  }
}

export const ACTIVATION_LATEX: Record<Activation, string> = {
  sigmoid: '\\sigma',
  tanh: '\\tanh',
  relu: '\\mathrm{ReLU}',
  linear: '\\mathrm{id}',
  step: 'H',
};

// ---------------------------------------------------------------- shapes

export function initWeights(layers: number[], seed: number): { weights: Weights; biases: Biases } {
  const rnd = mulberry32(seed * 9973 + 17);
  const weights: Weights = [];
  const biases: Biases = [];
  for (let l = 0; l < layers.length - 1; l++) {
    const nIn = layers[l];
    const nOut = layers[l + 1];
    const limit = Math.sqrt(6 / (nIn + nOut));
    const W: number[][] = [];
    const b: number[] = [];
    for (let j = 0; j < nOut; j++) {
      const row: number[] = [];
      for (let i = 0; i < nIn; i++) row.push(round4((rnd() * 2 - 1) * limit * 1.5));
      W.push(row);
      b.push(round4((rnd() * 2 - 1) * 0.5));
    }
    weights.push(W);
    biases.push(b);
  }
  return { weights, biases };
}

export function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

export function cloneNet(n: NetParams): NetParams {
  return {
    layers: [...n.layers],
    activation: n.activation,
    weights: n.weights.map((W) => W.map((r) => [...r])),
    biases: n.biases.map((b) => [...b]),
  };
}

export function paramCount(layers: number[]): number {
  let n = 0;
  for (let l = 0; l < layers.length - 1; l++) n += layers[l] * layers[l + 1] + layers[l + 1];
  return n;
}

// ---------------------------------------------------------------- forward

export interface Trace {
  z: number[][]; // pre-activations per layer (layer 0 = inputs)
  a: number[][]; // activations per layer
}

export function forward(net: NetParams, x: number[]): Trace {
  const z: number[][] = [x.slice()];
  const a: number[][] = [x.slice()];
  const L = net.weights.length;
  for (let l = 0; l < L; l++) {
    const W = net.weights[l];
    const b = net.biases[l];
    const out = l === L - 1 ? 'sigmoid' : net.activation;
    const zl: number[] = [];
    const al: number[] = [];
    for (let j = 0; j < W.length; j++) {
      let s = b[j];
      for (let i = 0; i < W[j].length; i++) s += W[j][i] * a[l][i];
      zl.push(s);
      al.push(act(out, s));
    }
    z.push(zl);
    a.push(al);
  }
  return { z, a };
}

export function predict(net: NetParams, x: number[]): number {
  const t = forward(net, x);
  return t.a[t.a.length - 1][0];
}

const EPS = 1e-7;

export function bce(p: number, y: number): number {
  const q = Math.min(1 - EPS, Math.max(EPS, p));
  return -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
}

export interface Metrics {
  loss: number;
  accuracy: number;
  correct: number;
  total: number;
  predictions: number[];
}

export function evaluate(net: NetParams, data: Point[]): Metrics {
  if (data.length === 0) return { loss: 0, accuracy: 0, correct: 0, total: 0, predictions: [] };
  let loss = 0;
  let correct = 0;
  const predictions: number[] = [];
  for (const p of data) {
    const y = predict(net, p.x);
    predictions.push(y);
    loss += bce(y, p.y);
    if ((y >= 0.5 ? 1 : 0) === p.y) correct++;
  }
  return { loss: loss / data.length, accuracy: correct / data.length, correct, total: data.length, predictions };
}

// --------------------------------------------------------------- backprop

export function gradients(net: NetParams, data: Point[]): { gW: Weights; gB: Biases; norm: number } {
  const L = net.weights.length;
  const gW: Weights = net.weights.map((W) => W.map((r) => r.map(() => 0)));
  const gB: Biases = net.biases.map((b) => b.map(() => 0));
  for (const p of data) {
    const { z, a } = forward(net, p.x);
    // output: sigmoid + BCE ⇒ dL/dz = a - y
    let delta: number[] = [a[L][0] - p.y];
    for (let l = L - 1; l >= 0; l--) {
      const W = net.weights[l];
      for (let j = 0; j < W.length; j++) {
        gB[l][j] += delta[j];
        for (let i = 0; i < W[j].length; i++) gW[l][j][i] += delta[j] * a[l][i];
      }
      if (l > 0) {
        const prev: number[] = [];
        for (let i = 0; i < net.weights[l][0].length; i++) {
          let s = 0;
          for (let j = 0; j < W.length; j++) s += W[j][i] * delta[j];
          prev.push(s * dact(net.activation, z[l][i]));
        }
        delta = prev;
      }
    }
  }
  const n = Math.max(1, data.length);
  let sq = 0;
  for (const W of gW) for (const r of W) for (let i = 0; i < r.length; i++) {
    r[i] /= n;
    sq += r[i] * r[i];
  }
  for (const b of gB) for (let j = 0; j < b.length; j++) {
    b[j] /= n;
    sq += b[j] * b[j];
  }
  return { gW, gB, norm: Math.sqrt(sq) };
}

export interface TrainConfig {
  learningRate: number;
  epochs: number;
}

export interface Snapshot {
  epoch: number;
  weights: Weights;
  biases: Biases;
}

export interface TrainResult {
  loss: number[]; // downsampled
  accuracy: number[]; // downsampled
  gradNorm: number[]; // downsampled
  sampleEvery: number;
  snapshots: Snapshot[];
  finalLoss: number;
  finalAccuracy: number;
  finalGradNorm: number;
  convergedAt: number | null; // first epoch with 100% accuracy and loss < 0.1
  final: { weights: Weights; biases: Biases };
  trainable: boolean;
}

/** Full-batch gradient descent. Pure and deterministic. */
export function train(start: NetParams, data: Point[], cfg: TrainConfig): TrainResult {
  const net = cloneNet(start);
  const epochs = Math.max(0, Math.floor(cfg.epochs));
  const sampleEvery = Math.max(1, Math.ceil(epochs / 200));
  const snapEvery = Math.max(1, Math.ceil(epochs / 24));
  const loss: number[] = [];
  const accuracy: number[] = [];
  const gradNorm: number[] = [];
  const snapshots: Snapshot[] = [{ epoch: 0, weights: cloneNet(net).weights, biases: cloneNet(net).biases }];
  let convergedAt: number | null = null;
  let lastNorm = 0;
  for (let e = 0; e < epochs; e++) {
    const g = gradients(net, data);
    lastNorm = g.norm;
    if (e % sampleEvery === 0) {
      const m = evaluate(net, data);
      loss.push(m.loss);
      accuracy.push(m.accuracy);
      gradNorm.push(g.norm);
    }
    for (let l = 0; l < net.weights.length; l++) {
      for (let j = 0; j < net.weights[l].length; j++) {
        net.biases[l][j] -= cfg.learningRate * g.gB[l][j];
        for (let i = 0; i < net.weights[l][j].length; i++) net.weights[l][j][i] -= cfg.learningRate * g.gW[l][j][i];
      }
    }
    if (convergedAt === null && (e % 10 === 9 || e === epochs - 1)) {
      const m = evaluate(net, data);
      if (m.accuracy === 1 && m.loss < 0.1) convergedAt = e + 1;
    }
    if ((e + 1) % snapEvery === 0 || e === epochs - 1) {
      const c = cloneNet(net);
      snapshots.push({ epoch: e + 1, weights: roundW(c.weights), biases: roundB(c.biases) });
    }
  }
  const m = evaluate(net, data);
  return {
    loss: loss.map(round4),
    accuracy,
    gradNorm: gradNorm.map(round4),
    sampleEvery,
    snapshots,
    finalLoss: round4(m.loss),
    finalAccuracy: m.accuracy,
    finalGradNorm: round4(lastNorm),
    convergedAt,
    final: { weights: roundW(net.weights), biases: roundB(net.biases) },
    trainable: net.activation !== 'step' || net.weights.length === 1,
  };
}

const roundW = (w: Weights): Weights => w.map((W) => W.map((r) => r.map(round4)));
const roundB = (b: Biases): Biases => b.map((r) => r.map(round4));

// ----------------------------------------------------------- projections

export interface Domain {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export function domainFor(data: Point[]): Domain {
  if (data.length === 0) return { x0: -0.5, x1: 1.5, y0: -0.5, y1: 1.5 };
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of data) {
    x0 = Math.min(x0, p.x[0]);
    x1 = Math.max(x1, p.x[0]);
    y0 = Math.min(y0, p.x[1]);
    y1 = Math.max(y1, p.x[1]);
  }
  const pad = Math.max(0.5, (x1 - x0) * 0.25, (y1 - y0) * 0.25);
  return { x0: x0 - pad, x1: x1 + pad, y0: y0 - pad, y1: y1 + pad };
}

/** row-major grid of network outputs; row 0 is the top (max y) */
export function decisionGrid(net: NetParams, dom: Domain, res: number): Float32Array {
  const out = new Float32Array(res * res);
  for (let r = 0; r < res; r++) {
    const y = dom.y1 - ((r + 0.5) / res) * (dom.y1 - dom.y0);
    for (let c = 0; c < res; c++) {
      const x = dom.x0 + ((c + 0.5) / res) * (dom.x1 - dom.x0);
      out[r * res + c] = predict(net, [x, y]);
    }
  }
  return out;
}

/** Loss as one weight is swept over a range around its current value. */
export function weightSweep(
  net: NetParams,
  data: Point[],
  path: [number, number, number] | ['b', number, number],
  span: number,
  n = 61,
): { xs: number[]; loss: number[]; acc: number[]; current: number } {
  const c = cloneNet(net);
  const get = () => (path[0] === 'b' ? c.biases[path[1]][path[2]] : c.weights[path[0]][path[1]][path[2]]);
  const set = (v: number) => {
    if (path[0] === 'b') c.biases[path[1]][path[2]] = v;
    else c.weights[path[0]][path[1]][path[2]] = v;
  };
  const current = get();
  const xs: number[] = [];
  const loss: number[] = [];
  const acc: number[] = [];
  for (let k = 0; k < n; k++) {
    const v = current - span + (2 * span * k) / (n - 1);
    set(v);
    const m = evaluate(c, data);
    xs.push(v);
    loss.push(m.loss);
    acc.push(m.accuracy);
  }
  return { xs, loss, acc, current };
}

export interface Sensitivity {
  path: [number, number, number];
  score: number; // max |Δloss| for a perturbation of ±0.5
  accuracyFlips: boolean;
}

export function sensitivities(net: NetParams, data: Point[]): Sensitivity[] {
  const base = evaluate(net, data);
  const out: Sensitivity[] = [];
  net.weights.forEach((W, l) =>
    W.forEach((row, j) =>
      row.forEach((_, i) => {
        let score = 0;
        let flips = false;
        for (const d of [-0.5, 0.5]) {
          const c = cloneNet(net);
          c.weights[l][j][i] += d;
          const m = evaluate(c, data);
          score = Math.max(score, Math.abs(m.loss - base.loss));
          if (m.accuracy !== base.accuracy) flips = true;
        }
        out.push({ path: [l, j, i], score, accuracyFlips: flips });
      }),
    ),
  );
  return out.sort((a, b) => b.score - a.score);
}

/** Is the labelled set linearly separable? Exact check for tiny datasets via perceptron with a cap. */
export function linearlySeparable(data: Point[]): boolean {
  if (data.length <= 2) return true;
  let w = [0, 0];
  let b = 0;
  for (let epoch = 0; epoch < 2000; epoch++) {
    let errors = 0;
    for (const p of data) {
      const t = p.y === 1 ? 1 : -1;
      const s = w[0] * p.x[0] + w[1] * p.x[1] + b;
      if (t * s <= 0) {
        w = [w[0] + t * p.x[0], w[1] + t * p.x[1]];
        b += t;
        errors++;
      }
    }
    if (errors === 0) return true;
  }
  return false;
}

export function hashString(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
