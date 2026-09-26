// The kind registry. Every object kind is described here once; the kernel, the protocol
// validator, the inspector UI and the AI's tool description are generated from it.

import type { ObjectKind, ParamSpec, ParamValue, Port, TSObject, Workspace } from './types';
import { ACTIVATIONS, initWeights, round4, type Activation, type Point } from './nn';
import { providers, scalarOf, systemOf, trialsOf } from './calc';
import {
  datasetFor,
  describeArchitecture,
  layersOf,
  networkMetrics,
  relationsFrom,
  sourceOf,
} from './semantics';

export interface ActionSpec {
  description: string;
  args: ParamSpec[];
  /** returns new params/state (materialised) or an error string */
  apply(o: TSObject, args: Record<string, ParamValue>): { params?: Record<string, ParamValue>; state?: any } | string;
}

export interface KindSpec {
  kind: ObjectKind;
  title: string;
  description: string;
  params: ParamSpec[];
  size: { w: number; h: number };
  ports(o: TSObject): { inputs: Port[]; outputs: Port[] };
  defaultState(params: Record<string, ParamValue>, init: any): any;
  /** state consequences of a parameter change (e.g. new architecture ⇒ new weights) */
  onParamChange?(o: TSObject, name: string, value: ParamValue): any | undefined;
  actions?: Record<string, ActionSpec>;
  /** can the AI (or anyone) create this kind directly with create_object? */
  creatable: boolean;
  summarize(o: TSObject, ws: Workspace): Record<string, unknown>;
}

// ---------------------------------------------------------------- params

export function coerceParam(spec: ParamSpec, v: unknown): { value?: ParamValue; error?: string } {
  const bad = (why: string) => ({ error: `parameter "${spec.name}": ${why}` });
  switch (spec.type) {
    case 'number':
    case 'int': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) return bad(`expected a number, got ${JSON.stringify(v)}`);
      if (spec.type === 'int' && !Number.isInteger(n)) return bad('expected an integer');
      if (spec.min !== undefined && n < spec.min) return bad(`must be ≥ ${spec.min}`);
      if (spec.max !== undefined && n > spec.max) return bad(`must be ≤ ${spec.max}`);
      return { value: n };
    }
    case 'enum':
      if (typeof v !== 'string' || !spec.options!.includes(v)) return bad(`must be one of ${spec.options!.join(', ')}`);
      return { value: v };
    case 'bool':
      if (typeof v !== 'boolean') return bad('expected true/false');
      return { value: v };
    case 'string':
      if (typeof v !== 'string') return bad('expected a string');
      return { value: v };
    case 'int_list': {
      let arr = v;
      if (typeof v === 'string') arr = v.trim() === '' ? [] : v.split(/[\s,]+/).map(Number);
      if (typeof v === 'number') arr = [v];
      if (!Array.isArray(arr) || arr.some((x) => typeof x !== 'number' || !Number.isInteger(x)))
        return bad('expected a list of integers, e.g. [2] or [3, 2]');
      if (spec.min !== undefined && arr.some((x: number) => x < spec.min!)) return bad(`every entry must be ≥ ${spec.min}`);
      if (spec.max !== undefined && arr.some((x: number) => x > spec.max!)) return bad(`every entry must be ≤ ${spec.max}`);
      if (spec.maxLength !== undefined && arr.length > spec.maxLength) return bad(`at most ${spec.maxLength} entries`);
      return { value: arr as number[] };
    }
  }
}

export function defaultParams(spec: KindSpec): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const p of spec.params) out[p.name] = Array.isArray(p.default) ? [...p.default] : p.default;
  return out;
}

// --------------------------------------------------------------- datasets

export const DATASET_PRESETS: Record<string, Point[]> = {
  xor: tt([0, 1, 1, 0]),
  and: tt([0, 0, 0, 1]),
  or: tt([0, 1, 1, 1]),
  nand: tt([1, 1, 1, 0]),
  xnor: tt([1, 0, 0, 1]),
};

function tt(ys: number[]): Point[] {
  const xs: [number, number][] = [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ];
  return xs.map((x, i) => ({ x, y: ys[i] as 0 | 1 }));
}

export function matchPreset(pts: Point[]): string {
  for (const [name, p] of Object.entries(DATASET_PRESETS)) {
    if (p.length === pts.length && p.every((q, i) => q.x[0] === pts[i].x[0] && q.x[1] === pts[i].x[1] && q.y === pts[i].y))
      return name;
  }
  return 'custom';
}

// ---------------------------------------------------------------- helpers

const r2 = (x: number) => Math.round(x * 100) / 100;

function reinit(o: TSObject, hidden: number[], seed: number) {
  const layers = [o.state.inputs ?? 2, ...hidden, 1];
  return { ...o.state, ...initWeights(layers, seed), trainedBy: null, handEdited: false };
}

function withWeight(o: TSObject, layer: number, to: number, from: number, value: number) {
  const weights = o.state.weights.map((W: number[][], l: number) =>
    l !== layer ? W : W.map((row, j) => (j !== to ? row : row.map((w, i) => (i === from ? round4(value) : w)))),
  );
  return { ...o.state, weights, handEdited: true };
}

// ---------------------------------------------------------------- registry

const nn: KindSpec = {
  kind: 'neural_network',
  title: 'Neural network',
  description:
    'A small multilayer perceptron with 2 inputs and 1 sigmoid output. Hidden layer sizes, hidden activation and training hyper-parameters are parameters; weights live in state and can be set directly. Its data comes from a dataset connected with feeds_into.',
  params: [
    { name: 'hidden', type: 'int_list', default: [], min: 1, max: 8, maxLength: 3, description: 'hidden layer sizes, e.g. [] (single neuron), [2], [4, 2]' },
    { name: 'activation', type: 'enum', default: 'tanh', options: ACTIVATIONS, description: 'hidden-layer activation (output is always sigmoid)' },
    { name: 'learningRate', type: 'number', default: 1, min: 0.001, max: 10, step: 0.05, description: 'gradient-descent step size' },
    { name: 'epochs', type: 'int', default: 2000, min: 1, max: 20000, description: 'full-batch training epochs' },
    { name: 'seed', type: 'int', default: 1, min: 0, max: 100000, description: 'initialisation seed (changing it re-initialises weights)' },
  ],
  size: { w: 340, h: 260 },
  creatable: true,
  ports: () => ({ inputs: [{ name: 'data', type: 'data' }], outputs: [{ name: 'model', type: 'model' }] }),
  defaultState(params, init) {
    const layers = [2, ...(params.hidden as number[]), 1];
    return { inputs: 2, ...initWeights(layers, params.seed as number), trainedBy: null, handEdited: false, ...(init ?? {}) };
  },
  onParamChange(o, name, value) {
    if (name === 'hidden') return reinit(o, value as number[], o.params.seed as number);
    if (name === 'seed') return reinit(o, o.params.hidden as number[], value as number);
    return undefined;
  },
  actions: {
    add_layer: {
      description: 'insert a hidden layer (default at the end, i.e. just before the output)',
      args: [
        { name: 'units', type: 'int', default: 2, min: 1, max: 8, description: 'units in the new layer' },
        { name: 'index', type: 'int', default: -1, min: -1, max: 3, description: 'position among hidden layers; -1 = last' },
      ],
      apply(o, a) {
        const hidden = [...(o.params.hidden as number[])];
        if (hidden.length >= 3) return 'at most 3 hidden layers in this prototype';
        const idx = (a.index as number) < 0 ? hidden.length : Math.min(a.index as number, hidden.length);
        hidden.splice(idx, 0, a.units as number);
        return { params: { ...o.params, hidden }, state: reinit(o, hidden, o.params.seed as number) };
      },
    },
    remove_layer: {
      description: 'remove a hidden layer (default the last one)',
      args: [{ name: 'index', type: 'int', default: -1, min: -1, max: 3, description: 'hidden layer index; -1 = last' }],
      apply(o, a) {
        const hidden = [...(o.params.hidden as number[])];
        if (hidden.length === 0) return 'the network has no hidden layers';
        const idx = (a.index as number) < 0 ? hidden.length - 1 : (a.index as number);
        if (idx >= hidden.length) return `no hidden layer ${idx}`;
        hidden.splice(idx, 1);
        return { params: { ...o.params, hidden }, state: reinit(o, hidden, o.params.seed as number) };
      },
    },
    set_units: {
      description: 'change the number of units of one hidden layer',
      args: [
        { name: 'index', type: 'int', default: 0, min: 0, max: 3, description: 'hidden layer index' },
        { name: 'units', type: 'int', default: 2, min: 1, max: 8, description: 'units' },
      ],
      apply(o, a) {
        const hidden = [...(o.params.hidden as number[])];
        if ((a.index as number) >= hidden.length) return `no hidden layer ${a.index}`;
        hidden[a.index as number] = a.units as number;
        return { params: { ...o.params, hidden }, state: reinit(o, hidden, o.params.seed as number) };
      },
    },
    set_weight: {
      description: 'set one weight W[layer][to][from] (layer 0 connects inputs to the first layer)',
      args: [
        { name: 'layer', type: 'int', default: 0, min: 0, max: 3, description: 'weight matrix index' },
        { name: 'to', type: 'int', default: 0, min: 0, max: 8, description: 'unit in the next layer' },
        { name: 'from', type: 'int', default: 0, min: 0, max: 8, description: 'unit in the previous layer' },
        { name: 'value', type: 'number', default: 0, min: -50, max: 50, description: 'new weight' },
      ],
      apply(o, a) {
        const W = o.state.weights[a.layer as number];
        if (!W || !W[a.to as number] || W[a.to as number][a.from as number] === undefined)
          return `no weight at layer ${a.layer}, to ${a.to}, from ${a.from}`;
        return { state: withWeight(o, a.layer as number, a.to as number, a.from as number, a.value as number) };
      },
    },
    set_bias: {
      description: 'set the bias of one unit',
      args: [
        { name: 'layer', type: 'int', default: 0, min: 0, max: 3, description: 'weight matrix index the unit belongs to' },
        { name: 'unit', type: 'int', default: 0, min: 0, max: 8, description: 'unit' },
        { name: 'value', type: 'number', default: 0, min: -50, max: 50, description: 'bias' },
      ],
      apply(o, a) {
        const b = o.state.biases[a.layer as number];
        if (!b || b[a.unit as number] === undefined) return `no bias at layer ${a.layer}, unit ${a.unit}`;
        const biases = o.state.biases.map((bl: number[], l: number) =>
          l !== a.layer ? bl : bl.map((v, j) => (j === a.unit ? round4(a.value as number) : v)),
        );
        return { state: { ...o.state, biases, handEdited: true } };
      },
    },
    reinitialize: {
      description: 're-initialise weights from the seed (discarding training)',
      args: [],
      apply(o) {
        return { state: reinit(o, o.params.hidden as number[], o.params.seed as number) };
      },
    },
  },
  summarize(o, ws) {
    const m = networkMetrics(ws, o);
    return {
      architecture: describeArchitecture(layersOf(o)),
      hidden_activation: o.params.activation,
      output_activation: 'sigmoid',
      params: o.params,
      weights: o.state.weights.map((W: number[][]) => W.map((r) => r.map(r2))),
      biases: o.state.biases.map((b: number[]) => b.map(r2)),
      dataset: datasetFor(ws, o.id)?.id ?? null,
      metrics: m
        ? { loss: r2(m.loss), accuracy: m.accuracy, predictions: m.predictions.map(r2) }
        : 'no dataset connected',
      trained_by: o.state.trainedBy,
      hand_edited: o.state.handEdited,
      sub_references: 'neuron:L:J (L=1 first hidden/output layer), edge:L:J:I, boundary',
    };
  },
};

const dataset: KindSpec = {
  kind: 'dataset',
  title: 'Dataset',
  description: 'Labelled 2-D points. Presets: xor, and, or, nand, xnor. Points can be relabelled with flip_label.',
  params: [{ name: 'preset', type: 'enum', default: 'xor', options: ['xor', 'and', 'or', 'nand', 'xnor', 'custom'], description: 'truth table' }],
  size: { w: 236, h: 250 },
  creatable: true,
  ports: () => ({ inputs: [], outputs: [{ name: 'data', type: 'data' }] }),
  defaultState(params, init) {
    const p = DATASET_PRESETS[params.preset as string] ?? DATASET_PRESETS.xor;
    return { points: p.map((q) => ({ x: [...q.x], y: q.y })), ...(init ?? {}) };
  },
  onParamChange(o, name, value) {
    if (name !== 'preset' || value === 'custom') return undefined;
    return { ...o.state, points: DATASET_PRESETS[value as string].map((q) => ({ x: [...q.x], y: q.y })) };
  },
  actions: {
    add_point: {
      description: 'add a labelled point (e.g. drawn with the pen: orange = 1, blue = 0)',
      args: [
        { name: 'x1', type: 'number', default: 0, min: -10, max: 10, description: 'first coordinate' },
        { name: 'x2', type: 'number', default: 0, min: -10, max: 10, description: 'second coordinate' },
        { name: 'label', type: 'int', default: 1, min: 0, max: 1, description: 'class 0 or 1' },
      ],
      apply(o, a) {
        const pts = o.state.points as Point[];
        if (pts.length >= 64) return 'at most 64 points';
        const points = [...pts, { x: [round4(a.x1 as number), round4(a.x2 as number)] as [number, number], y: a.label as 0 | 1 }];
        return { state: { ...o.state, points }, params: { ...o.params, preset: matchPreset(points) } };
      },
    },
    remove_point: {
      description: 'remove point i',
      args: [{ name: 'index', type: 'int', default: 0, min: 0, max: 63, description: 'point index' }],
      apply(o, a) {
        const pts = o.state.points as Point[];
        if (!pts[a.index as number]) return `no point ${a.index}`;
        const points = pts.filter((_, i) => i !== a.index);
        return { state: { ...o.state, points }, params: { ...o.params, preset: matchPreset(points) } };
      },
    },
    flip_label: {
      description: 'flip the label of point i',
      args: [{ name: 'index', type: 'int', default: 0, min: 0, max: 63, description: 'point index' }],
      apply(o, a) {
        const pts = o.state.points as Point[];
        if (!pts[a.index as number]) return `no point ${a.index}`;
        const points = pts.map((p, i) => (i === a.index ? { x: p.x, y: (1 - p.y) as 0 | 1 } : p));
        return { state: { ...o.state, points }, params: { ...o.params, preset: matchPreset(points) } };
      },
    },
  },
  summarize(o) {
    return { points: (o.state.points as Point[]).map((p) => [...p.x, p.y]), preset: o.params.preset, format: '[x1, x2, label]' };
  },
};

const graph: KindSpec = {
  kind: 'graph',
  title: 'Graph',
  description:
    'A plot that visualizes other objects (graph --visualizes--> source). Modes: curve (one or more formulas against a variable x over [from, to], with a marker at the current value), series (a system: y names against x, e.g. x="t", y="S,I,R", or a trajectory x="x", y="y"), histogram (random trials), decision_boundary (network output over input space with the data points), loss_curve (training history), weight_sweep (loss as one weight varies; weight="L:J:I"), activation (a function).',
  params: [
    { name: 'mode', type: 'enum', default: 'decision_boundary', options: ['curve', 'series', 'histogram', 'decision_boundary', 'loss_curve', 'weight_sweep', 'activation'], description: 'what to plot' },
    { name: 'x', type: 'string', default: '', description: 'curve: the variable on the x-axis; series: the series on the x-axis (default t)' },
    { name: 'y', type: 'string', default: '', description: 'series: comma-separated names to plot (default: all state variables)' },
    { name: 'from', type: 'number', default: 0, min: -1e9, max: 1e9, description: 'curve: start of the x range (default: the variable\'s slider range)' },
    { name: 'to', type: 'number', default: 0, min: -1e9, max: 1e9, description: 'curve: end of the x range (from = to means: the slider range)' },
    { name: 'weight', type: 'string', default: '0:0:0', description: 'for weight_sweep: weight path L:J:I' },
    { name: 'span', type: 'number', default: 4, min: 0.5, max: 20, description: 'for weight_sweep: ± range around the current value' },
  ],
  size: { w: 260, h: 280 },
  creatable: true,
  ports: () => ({ inputs: [{ name: 'source', type: 'any' }], outputs: [] }),
  defaultState: (_p, init) => ({ ...(init ?? {}) }),
  summarize(o, ws) {
    const src = sourceOf(ws, o.id);
    const sources = relationsFrom(ws, o.id, 'visualizes').map((r) => r.to);
    return {
      mode: o.params.mode,
      source: src?.id ?? null,
      ...(sources.length > 1 ? { sources } : {}),
      ...(o.params.mode === 'weight_sweep' ? { weight: o.params.weight } : {}),
      ...(['curve', 'series'].includes(o.params.mode as string) ? { x: o.params.x, y: o.params.y || undefined } : {}),
    };
  },
};

const fn: KindSpec = {
  kind: 'function',
  title: 'Function',
  description: 'An activation function f(x) drawn with its derivative; drag along it to probe values.',
  params: [
    { name: 'fn', type: 'enum', default: 'sigmoid', options: ACTIVATIONS, description: 'function' },
    { name: 'derivative', type: 'bool', default: true, description: 'show derivative' },
  ],
  size: { w: 240, h: 200 },
  creatable: true,
  ports: () => ({ inputs: [], outputs: [{ name: 'function', type: 'function' }] }),
  defaultState: (_p, init) => ({ ...(init ?? {}) }),
  summarize: (o) => ({ fn: o.params.fn }),
};

const equation: KindSpec = {
  kind: 'equation',
  title: 'Equation',
  description:
    'A formula. form=custom shows state.latex. form=neuron|boundary|network derive live LaTeX from the network it visualizes (equation --visualizes--> network); focus="L:J" picks a neuron.',
  params: [
    { name: 'form', type: 'enum', default: 'custom', options: ['custom', 'neuron', 'boundary', 'network', 'arithmetic'], description: 'what the equation shows' },
    { name: 'focus', type: 'string', default: '1:0', description: 'neuron L:J for form=neuron/arithmetic' },
    { name: 'input', type: 'string', default: '1,0', description: 'input x1,x2 for form=arithmetic' },
  ],
  size: { w: 320, h: 120 },
  creatable: true,
  ports: () => ({ inputs: [{ name: 'source', type: 'model' }], outputs: [] }),
  defaultState: (_p, init) => ({ latex: '', ...(init ?? {}) }),
  summarize: (o, ws) => ({ form: o.params.form, focus: o.params.focus, latex: o.state.latex || undefined, source: sourceOf(ws, o.id)?.id ?? null }),
};

const text: KindSpec = {
  kind: 'text',
  title: 'Note',
  description: 'A piece of prose: a question, an explanation, an annotation. Attach it to an object with annotates.',
  params: [],
  size: { w: 280, h: 110 },
  creatable: true,
  ports: () => ({ inputs: [], outputs: [] }),
  defaultState: (_p, init) => ({ text: '', ...(init ?? {}) }),
  summarize: (o, ws) => ({ text: o.state.text, annotates: relationsFrom(ws, o.id, 'annotates').map((r) => r.to) }),
};

const simulation: KindSpec = {
  kind: 'simulation',
  title: 'Training run',
  description: 'A deterministic gradient-descent run of a network (created by the execute operation). Holds loss curve, snapshots and final metrics.',
  params: [],
  size: { w: 280, h: 230 },
  creatable: false,
  ports: () => ({ inputs: [{ name: 'model', type: 'model' }], outputs: [{ name: 'series', type: 'series' }] }),
  defaultState: (_p, init) => ({ ...(init ?? {}) }),
  summarize(o) {
    const s = o.state;
    return {
      source: s.source,
      config: { architecture: describeArchitecture(s.config.layers), activation: s.config.activation, learningRate: s.config.learningRate, epochs: s.config.epochs, seed: s.config.seed },
      result: { finalLoss: s.result.finalLoss, finalAccuracy: s.result.finalAccuracy, convergedAt: s.result.convergedAt, finalGradNorm: s.result.finalGradNorm },
    };
  },
};

const experiment: KindSpec = {
  kind: 'experiment',
  title: 'Experiment',
  description: 'A controlled, reproducible experiment: one variable changed across values, everything else held constant, several seeds, measured outcomes and a deterministic verdict on the hypothesis.',
  params: [],
  size: { w: 460, h: 370 },
  creatable: false,
  ports: () => ({ inputs: [{ name: 'model', type: 'model' }], outputs: [] }),
  defaultState: (_p, init) => ({ ...(init ?? {}) }),
  summarize(o) {
    const s = o.state;
    return {
      hypothesis: s.hypothesis,
      target: s.target,
      variable: s.variable,
      constants: s.constants,
      seeds: s.seeds,
      measures: s.measures,
      results: s.results?.map((r: any) => ({ value: r.value, ...r.summary })),
      verdicts: s.verdicts,
      conclusion: s.conclusion,
      hash: s.hash,
    };
  },
};

const comparison: KindSpec = {
  kind: 'comparison',
  title: 'Comparison',
  description: 'A live side-by-side comparison of two objects (comparison --compares_with--> a, b).',
  params: [],
  size: { w: 470, h: 350 },
  creatable: false,
  ports: () => ({ inputs: [{ name: 'a', type: 'any' }, { name: 'b', type: 'any' }], outputs: [] }),
  defaultState: (_p, init) => ({ ...(init ?? {}) }),
  summarize: (o) => ({ a: o.state.a, b: o.state.b }),
};

const claim: KindSpec = {
  kind: 'claim',
  title: 'Claim',
  description: 'A statement about the workspace. Starts unverified; only verify_claim with experiment/simulation evidence can mark it supported or refuted.',
  params: [],
  size: { w: 300, h: 120 },
  creatable: false,
  ports: () => ({ inputs: [], outputs: [] }),
  defaultState: (_p, init) => ({ text: '', status: 'unverified', about: [], evidence: [], ...(init ?? {}) }),
  summarize: (o) => ({ text: o.state.text, status: o.state.status, about: o.state.about, evidence: o.state.evidence }),
};

const group: KindSpec = {
  kind: 'group',
  title: 'Group',
  description: 'A named frame around several objects (group --composed_of--> members).',
  params: [],
  size: { w: 300, h: 200 },
  creatable: false,
  ports: () => ({ inputs: [], outputs: [] }),
  defaultState: (_p, init) => ({ members: [], ...(init ?? {}) }),
  summarize: (o) => ({ members: o.state.members }),
};

const glyph: KindSpec = {
  kind: 'glyph',
  title: 'Glyph',
  description:
    'A reusable abstraction over a construction. Keeps its members (glyph --composed_of--> member); exposes chosen inner parameters as its own parameters (set_parameter on the glyph writes through); can be expanded back into its graph and instantiated again from the library.',
  params: [],
  size: { w: 290, h: 270 },
  creatable: false,
  ports(o) {
    return { inputs: o.state.dataInput ? [{ name: 'data', type: 'data' }] : [], outputs: o.state.output ? [{ name: 'model', type: 'model' }] : [] };
  },
  defaultState: (_p, init) => ({ ...(init ?? {}) }),
  summarize: (o) => ({ name: o.state.name, definition: o.state.definition, members: o.state.members, exposed: o.state.exposed, output: o.state.output, expanded: !!o.visual.expanded }),
};

const sketch: KindSpec = {
  kind: 'sketch',
  title: 'Ink',
  description:
    'Freehand ink on the paper. The human draws it with the pen; you draw with the draw operation using semantic shapes (circle, underline, arrow, cross, check) around objects. Ink drawn over an object annotates it and moves with it.',
  params: [],
  size: { w: 40, h: 40 },
  creatable: false,
  ports: () => ({ inputs: [], outputs: [] }),
  defaultState: (_p, init) => ({ strokes: [], color: 'ink', shape: 'freeform', ...(init ?? {}) }),
  summarize(o, ws) {
    const over = relationsFrom(ws, o.id, 'annotates').map((r) => r.to);
    return {
      drawn_by: o.provenance.createdBy,
      shape: o.state.shape,
      color: o.state.color,
      strokes: (o.state.strokes as unknown[]).length,
      size: `${Math.round(o.visual.w)}×${Math.round(o.visual.h)}`,
      ...(over.length ? { on: over } : {}),
      ...(o.state.note ? { note: o.state.note } : {}),
    };
  },
};

// ------------------------------------------------------------------ open-lesson building blocks

const IDENT = /^[\p{L}_][\p{L}\p{N}_]*$/u;
export const isIdentifier = (s: unknown): s is string => typeof s === 'string' && IDENT.test(s);

const r3 = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? x : +x.toPrecision(4));

const variable: KindSpec = {
  kind: 'variable',
  title: 'Variable',
  description:
    'A named quantity with a slider (the thing the class manipulates): state {name, unit?, description?}, params {value, min, max, step}. It feeds formulas, systems and trials that use its name.',
  params: [
    { name: 'value', type: 'number', default: 1, min: -1e9, max: 1e9, description: 'current value' },
    { name: 'min', type: 'number', default: 0, min: -1e9, max: 1e9, description: 'slider minimum' },
    { name: 'max', type: 'number', default: 10, min: -1e9, max: 1e9, description: 'slider maximum' },
    { name: 'step', type: 'number', default: 0, min: 0, max: 1e9, description: 'slider step (0 = smooth)' },
  ],
  size: { w: 260, h: 104 },
  creatable: true,
  ports: () => ({ inputs: [], outputs: [{ name: 'value', type: 'any' }] }),
  defaultState: (_p, init) => ({ name: 'x', unit: '', description: '', ...(init ?? {}) }),
  summarize: (o) => ({ name: o.state.name, value: o.params.value, range: [o.params.min, o.params.max], ...(o.state.unit ? { unit: o.state.unit } : {}), ...(o.state.description ? { description: o.state.description } : {}) }),
};

const formula: KindSpec = {
  kind: 'formula',
  title: 'Formula',
  description:
    'A live, typeset formula name = expr (state {name, expr, unit?, description?}). Its value updates as the variables and formulas it uses change. Names it uses are linked automatically to the visible variables/formulas/systems/trials providing them.',
  params: [],
  size: { w: 330, h: 118 },
  creatable: true,
  ports: () => ({ inputs: [{ name: 'inputs', type: 'any' }], outputs: [{ name: 'value', type: 'any' }] }),
  defaultState: (_p, init) => ({ name: 'y', expr: '0', unit: '', description: '', ...(init ?? {}) }),
  summarize(o, ws) {
    const v = scalarOf(ws, o);
    return {
      name: o.state.name,
      expr: o.state.expr,
      value: v.ok ? r3(v.value) : `error: ${v.error}`,
      inputs: providers(ws, o.id).map((p) => p.id),
      ...(o.state.unit ? { unit: o.state.unit } : {}),
      ...(o.state.description ? { description: o.state.description } : {}),
    };
  },
};

const system: KindSpec = {
  kind: 'system',
  title: 'System',
  description:
    'Differential equations integrated numerically (RK4): state {name, vars: [{name, init, rate}] (d name/dt = rate), helpers?: [{name, expr}], stop?: expr (stop when true, e.g. "y < 0")}, params {t_max, dt}. Outputs for other objects and experiments: t_end and, per variable/helper v, v_end, v_max, v_min, t_v_max.',
  params: [
    { name: 't_max', type: 'number', default: 10, min: 0.001, max: 1e7, description: 'simulate until this time' },
    { name: 'dt', type: 'number', default: 0.01, min: 1e-6, max: 1e5, description: 'integration step' },
  ],
  size: { w: 360, h: 210 },
  creatable: true,
  ports: () => ({ inputs: [{ name: 'inputs', type: 'any' }], outputs: [{ name: 'series', type: 'series' }] }),
  defaultState: (_p, init) => ({ name: 'system', vars: [], helpers: [], stop: '', description: '', ...(init ?? {}) }),
  summarize(o, ws) {
    const run = systemOf(ws, o);
    return {
      name: o.state.name,
      vars: o.state.vars,
      helpers: o.state.helpers,
      stop: o.state.stop || undefined,
      t_max: o.params.t_max,
      dt: o.params.dt,
      inputs: providers(ws, o.id).map((p) => p.id),
      outputs: run.ok ? Object.fromEntries(Object.entries(run.value.outputs).filter(([k]) => !k.startsWith('t_') || k === 't_end' || /^t_\w+_max$/.test(k)).map(([k, v]) => [k, r3(v)])) : `error: ${run.error}`,
    };
  },
};

const trials: KindSpec = {
  kind: 'trials',
  title: 'Random trials',
  description:
    'Repeat a random expression many times (seeded, reproducible) and show the histogram: state {name, expr, description?}, params {trials, seed, bins}. Random functions: rand() randn() randint(a,b) coin(p) randexp(rate); meanof(n, expr)/sumof(n, expr) repeat inside one trial. Outputs: name_mean, name_sd, name_skew, name_kurtosis, name_median, name_min, name_max.',
  params: [
    { name: 'trials', type: 'int', default: 2000, min: 1, max: 50000, description: 'number of repetitions' },
    { name: 'seed', type: 'int', default: 1, min: 0, max: 1e9, description: 'random seed (same seed, same results)' },
    { name: 'bins', type: 'int', default: 30, min: 3, max: 120, description: 'histogram bins' },
  ],
  size: { w: 340, h: 250 },
  creatable: true,
  ports: () => ({ inputs: [{ name: 'inputs', type: 'any' }], outputs: [{ name: 'stats', type: 'any' }] }),
  defaultState: (_p, init) => ({ name: 'X', expr: 'rand()', description: '', ...(init ?? {}) }),
  summarize(o, ws) {
    const run = trialsOf(ws, o);
    return {
      name: o.state.name,
      expr: o.state.expr,
      trials: o.params.trials,
      seed: o.params.seed,
      inputs: providers(ws, o.id).map((p) => p.id),
      stats: run.ok ? Object.fromEntries(Object.entries(run.value.stats).map(([k, v]) => [k, r3(v)])) : `error: ${run.error}`,
    };
  },
};

export const KINDS: Record<ObjectKind, KindSpec> = {
  neural_network: nn,
  dataset,
  graph,
  function: fn,
  equation,
  text,
  simulation,
  experiment,
  comparison,
  claim,
  group,
  glyph,
  sketch,
  variable,
  formula,
  system,
  trials,
};

export function kindSpec(kind: string): KindSpec | undefined {
  return (KINDS as Record<string, KindSpec>)[kind];
}

export function isActivation(v: unknown): v is Activation {
  return typeof v === 'string' && (ACTIVATIONS as string[]).includes(v);
}
