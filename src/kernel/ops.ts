// The semantic operation protocol. Every client (UI, offline planner, Claude) submits
// these operations; this module validates them and compiles them into events.
// Nothing here trusts its caller: every argument is checked.

import type {
  ActorKind,
  ExposedParam,
  GlyphDefinition,
  ObjectId,
  Operation,
  ParamValue,
  Relation,
  RelationType,
  SemanticPlacement,
  TSObject,
  VisualState,
  Workspace,
  WorkspaceEvent,
} from './types';
import { RELATION_TYPES } from './types';
import { coerceParam, defaultParams, kindSpec, KINDS } from './kinds';
import { reduce } from './reduce';
import { bbox, findFree, pack, place, placeBlock } from './layout';
import { datasetFor, labelOf, layersOf, netParams, points, relationsFrom, relationsOf, relationsTo, resolve } from './semantics';
import { describeArchitecture } from './semantics';
import { train } from './nn';
import { formatValue, METRICS, runExperiment, type Expectation, type ExperimentSpec } from './experiment';

export class OpError extends Error {}

const PLACEMENT_ALIASES: Record<string, string> = {
  right_of: 'beside', right: 'beside', next_to: 'beside', besides: 'beside', after: 'beside',
  left: 'left_of', before: 'left_of',
  under: 'below', beneath: 'below', bottom: 'below',
  over: 'above', top: 'above', on_top_of: 'above',
  close_to: 'near', by: 'near',
};

const METRIC_ALIASES: Record<string, string> = {
  success: 'success_rate', converged: 'success_rate', convergence_rate: 'success_rate', convergence: 'success_rate', solve_rate: 'success_rate',
  loss: 'mean_final_loss', final_loss: 'mean_final_loss', mean_loss: 'mean_final_loss',
  accuracy: 'mean_accuracy', final_accuracy: 'mean_accuracy', acc: 'mean_accuracy', max_accuracy: 'best_accuracy',
  converged_at: 'mean_converged_at', convergence_epoch: 'mean_converged_at', epochs_to_converge: 'mean_converged_at',
  grad_norm: 'mean_grad_norm', gradient_norm: 'mean_grad_norm',
};

const OP_ALIASES: Record<string, string> = {
  lt: '<', less_than: '<', lte: '<=', le: '<=', '≤': '<=', at_most: '<=',
  gt: '>', greater_than: '>', gte: '>=', ge: '>=', '≥': '>=', at_least: '>=',
  eq: '==', '=': '==', '===': '==', equals: '==',
};

const fail = (msg: string): never => {
  throw new OpError(msg);
};

// -------------------------------------------------------------- op catalogue

export interface OpDoc {
  op: string;
  summary: string;
  args: string;
}

export const OPS: OpDoc[] = [
  { op: 'create_object', summary: 'create an object of a kind', args: '{kind, label?, params?, state?, placement?, ref?, source?, dataset?}' },
  { op: 'delete_object', summary: 'delete an object (and its relations; a glyph deletes its construction)', args: '{id}' },
  { op: 'modify_object', summary: 'change label and/or editable semantic state', args: '{id, label?, state?}' },
  { op: 'set_parameter', summary: 'set one parameter (on a glyph: an exposed parameter)', args: '{id, param, value}' },
  { op: 'invoke', summary: 'run a kind-specific action (add_layer, set_weight, flip_label …)', args: '{id, action, args?}' },
  { op: 'move_object', summary: 'move an object semantically', args: '{id, placement}' },
  { op: 'resize_object', summary: 'resize', args: '{id, size: "small"|"medium"|"large"}' },
  { op: 'connect', summary: 'add a typed relation', args: '{from, to, relation}' },
  { op: 'disconnect', summary: 'remove a relation', args: '{id} or {from, to, relation}' },
  { op: 'duplicate', summary: 'copy an object (keeps its data connection)', args: '{id, placement?, ref?}' },
  { op: 'group', summary: 'frame several objects under a name', args: '{ids, label, ref?}' },
  { op: 'ungroup', summary: 'remove a group frame', args: '{id}' },
  { op: 'abstract', summary: 'turn a construction into a reusable glyph', args: '{ids, name, expose?: [{id, param, name?}], output?, description?, ref?}' },
  { op: 'expand', summary: 'expand/collapse a glyph to show its construction', args: '{id, expanded?}' },
  { op: 'instantiate_glyph', summary: 'create a new instance of a glyph from the library', args: '{definition, placement?, ref?}' },
  { op: 'execute', summary: 'train a network deterministically (creates/updates a training-run object)', args: '{id, ref?} (ref names the training run)' },
  { op: 'plot', summary: 'create a graph visualizing an object', args: '{source, mode?, weight?, placement?, ref?}' },
  { op: 'zoom_into', summary: 'semantic zoom: a linked equation one level down', args: '{id, form: "neuron"|"boundary"|"network"|"arithmetic", focus?: "L:J", input?: "x1,x2", ref?}' },
  { op: 'experiment', summary: 'run a controlled, reproducible experiment on a network', args: '{target, hypothesis: {text, expect?: [{value?, metric, op, threshold}]}, variable: {param: hidden|activation|learningRate|epochs, values}, seeds?, ref?} — each expectation compares the metric of one value with a threshold or with another value (than); metric: success_rate|mean_final_loss|best_accuracy|mean_accuracy|mean_converged_at|mean_grad_norm; op: < <= > >= ==. Without expectations an experiment is inconclusive and cannot verify claims' },
  { op: 'reproduce', summary: 're-run an experiment and check its results hash', args: '{id}' },
  { op: 'branch', summary: 'fork objects into an explicit alternative with a stated assumption', args: '{ids, assumption, changes?: [{id, param, value} | {id, action, args}], execute?, label?, ref?}' },
  { op: 'compare', summary: 'create a live comparison of two objects', args: '{a, b, placement?, ref?}' },
  { op: 'annotate', summary: 'attach a note to an object (optionally a sub-part like neuron:1:0)', args: '{target, text, subtarget?, ref?}' },
  { op: 'claim', summary: 'state a claim about objects (starts unverified)', args: '{text, about, ref?}' },
  { op: 'verify_claim', summary: 'attach experiment evidence; the claim becomes supported/refuted by the experiment verdict', args: '{claim, evidence}' },
];

const PREFIX: Record<string, string> = {
  neural_network: 'net',
  dataset: 'data',
  graph: 'plot',
  function: 'fn',
  equation: 'eq',
  text: 'note',
  simulation: 'run',
  experiment: 'exp',
  comparison: 'cmp',
  claim: 'claim',
  group: 'group',
  glyph: 'glyph',
};

/** state keys a client may write through modify_object */
const EDITABLE: Record<string, string[]> = {
  text: ['text'],
  equation: ['latex'],
  claim: ['text'],
  neural_network: ['weights', 'biases'],
  dataset: ['points'],
  glyph: ['name'],
};

// -------------------------------------------------------------- transaction builder

export class TxBuilder {
  ws: Workspace;
  events: WorkspaceEvent[] = [];
  refs: Record<string, ObjectId> = {};
  created: ObjectId[] = [];
  notes: string[] = [];
  private counter: number;
  private pending: VisualState[] = [];

  constructor(
    base: Workspace,
    readonly actor: ActorKind,
    readonly txId: string,
    readonly at: number,
    /** names bound by earlier batches in the same agent turn */
    seedRefs: Record<string, ObjectId> = {},
  ) {
    this.ws = base;
    this.counter = base.counter;
    for (const [k, v] of Object.entries(seedRefs)) if (base.objects[v]) this.refs[k] = v;
  }

  newId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }

  emit(e: WorkspaceEvent) {
    this.events.push(e);
    this.ws = reduce(this.ws, e);
  }

  base(op: string) {
    return { actor: this.actor, at: this.at, txId: this.txId, op };
  }

  finish() {
    if (this.counter !== this.ws.counter)
      this.emit({ type: 'CounterAdvanced', counter: this.counter, ...this.base('ids') });
  }

  /** resolve an object reference: $ref, id, or a unique label */
  id(v: unknown, what = 'object'): ObjectId {
    if (typeof v !== 'string' || v === '') return fail(`${what}: expected an object id`);
    if (v.startsWith('$')) {
      const r = this.refs[v.slice(1).replace(/^ref:/, '')];
      if (!r) return fail(`${what}: unknown reference ${v}`);
      return r;
    }
    if (this.ws.objects[v]) return v;
    // a ref name written without its "$"
    if (this.refs[v] && this.ws.objects[this.refs[v]]) return this.refs[v];
    const byLabel = Object.values(this.ws.objects).filter((o) => o.label.toLowerCase() === v.toLowerCase());
    if (byLabel.length === 1) return byLabel[0].id;
    return fail(`${what}: no object "${v}"`);
  }

  get(id: ObjectId): TSObject {
    return this.ws.objects[id] ?? fail(`no object ${id}`);
  }

  placement(p: unknown): SemanticPlacement | undefined {
    if (p === undefined || p === null) return undefined;
    // forgiving but unambiguous forms: "net_1", "below net_1", "below:net_1"
    if (typeof p === 'string') {
      const m = p.trim().match(/^(?:([a-z_]+)[\s:]+)?(\S+)$/i);
      if (!m) return fail('placement: expected {"beside": "net_1"}');
      p = { [m[1] ?? 'beside']: m[2] };
    }
    if (typeof p !== 'object') return fail('placement: expected an object like {"beside": "net_1"}');
    const entries = Object.entries(p as object).map(([k, v]) => [PLACEMENT_ALIASES[k] ?? k, v] as const);
    const known = entries.filter(([k]) => ['beside', 'below', 'above', 'left_of', 'near', 'at'].includes(k));
    if (known.length === 0) return fail(`placement: use one of beside/below/above/left_of/near (got ${entries.map(([k]) => k).join(', ') || 'nothing'})`);
    const [k, v] = known[0];
    if (k === 'at') {
      if (this.actor === 'ai') return fail('placement: the agent places objects semantically (beside/below/…), not by coordinates');
      if (typeof v?.x !== 'number' || typeof v?.y !== 'number') return fail('placement.at: expected {x, y}');
      return { at: { x: v.x, y: v.y } };
    }
    // placement is a layout hint: an anchor that doesn't resolve falls back to automatic layout
    try {
      return { [k]: this.id(v, `placement.${k}`) } as SemanticPlacement;
    } catch (e) {
      if (e instanceof OpError) return undefined;
      throw e;
    }
  }

  allocate(size: { w: number; h: number }, p: SemanticPlacement | undefined): VisualState {
    const v = place(this.ws, size, p, this.pending);
    this.pending.push(v);
    return v;
  }

  createObject(o: Omit<TSObject, 'provenance'> & { provenance?: Partial<TSObject['provenance']> }, op: string): TSObject {
    const full: TSObject = {
      ...o,
      provenance: {
        createdBy: this.actor,
        createdAt: this.at,
        operation: op,
        txId: this.txId,
        derivedFrom: [],
        verifiedBy: [],
        history: [],
        ...(o.provenance ?? {}),
      },
    };
    this.emit({ type: 'ObjectCreated', object: full, ...this.base(op) });
    this.created.push(full.id);
    return full;
  }

  modify(id: ObjectId, set: Extract<WorkspaceEvent, { type: 'ObjectModified' }>['set'], op: string, note?: string) {
    const o = this.get(id);
    const history = [...o.provenance.history, { actor: this.actor, at: this.at, op, txId: this.txId, ...(note ? { note } : {}) }].slice(-40);
    this.emit({
      type: 'ObjectModified',
      id,
      set: { ...set, provenance: { ...(set.provenance ?? o.provenance), history } },
      ...this.base(op),
    });
  }

  relate(type: RelationType, from: ObjectId, to: ObjectId, op: string, meta?: Record<string, unknown>): Relation {
    const relation: Relation = { id: this.newId('rel'), type, from, to, createdBy: this.actor, txId: this.txId, ...(meta ? { meta } : {}) };
    this.emit({ type: 'RelationAdded', relation, ...this.base(op) });
    return relation;
  }

  unrelate(id: string, op: string) {
    this.emit({ type: 'RelationRemoved', id, ...this.base(op) });
  }

  marker(type: Extract<WorkspaceEvent, { subject: string }>['type'], subject: ObjectId, op: string, detail?: Record<string, unknown>) {
    this.emit({ type, subject, ...(detail ? { detail } : {}), ...this.base(op) } as WorkspaceEvent);
  }

  setRef(ref: unknown, id: ObjectId) {
    if (ref === undefined) return;
    if (typeof ref !== 'string' || !/^[A-Za-z_][\w-]*$/.test(ref)) fail('ref: expected a short identifier like "net"');
    this.refs[ref as string] = id;
  }
}

// -------------------------------------------------------------- compile

export function compile(tx: TxBuilder, op: Operation): void {
  if (!op || typeof op !== 'object' || typeof op.op !== 'string') fail('each operation needs an "op" field');
  const handler = HANDLERS[op.op];
  if (!handler) fail(`unknown operation "${op.op}". Known: ${OPS.map((o) => o.op).join(', ')}`);
  handler(tx, op);
}

type Handler = (tx: TxBuilder, op: Operation) => void;

function sizeFor(kind: string) {
  return kindSpec(kind)!.size;
}

function coerceParams(kind: string, given: unknown): Record<string, ParamValue> {
  const spec = kindSpec(kind)!;
  const params = defaultParams(spec);
  if (given === undefined) return params;
  if (typeof given !== 'object' || given === null || Array.isArray(given)) fail('params: expected an object');
  for (const [k, v] of Object.entries(given as object)) {
    const ps = spec.params.find((p) => p.name === k);
    if (!ps) fail(`${kind} has no parameter "${k}". Parameters: ${spec.params.map((p) => p.name).join(', ') || 'none'}`);
    const c = coerceParam(ps!, v);
    if (c.error) fail(c.error);
    params[k] = c.value!;
  }
  return params;
}

function checkEditableState(o: { kind: string; params: Record<string, ParamValue> }, patch: unknown): Record<string, unknown> {
  if (patch === undefined) return {};
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) fail('state: expected an object');
  const allowed = EDITABLE[o.kind] ?? [];
  for (const [k, v] of Object.entries(patch as object)) {
    if (!allowed.includes(k)) {
      if (o.kind === 'claim' && k === 'status') fail('claim status can only change through verify_claim with evidence');
      fail(`state.${k} of a ${o.kind} is not directly editable${allowed.length ? ` (editable: ${allowed.join(', ')})` : ''}`);
    }
    if ((k === 'text' || k === 'latex' || k === 'name') && typeof v !== 'string') fail(`state.${k}: expected a string`);
    if (k === 'weights' || k === 'biases') checkShape(o, k, v);
    if (k === 'points') checkPoints(v);
  }
  return patch as Record<string, unknown>;
}

function checkShape(o: { params: Record<string, ParamValue> }, k: string, v: unknown) {
  const layers = [2, ...((o.params.hidden as number[]) ?? []), 1];
  const ok =
    Array.isArray(v) &&
    v.length === layers.length - 1 &&
    v.every((m, l) =>
      k === 'weights'
        ? Array.isArray(m) && m.length === layers[l + 1] && m.every((r: unknown) => Array.isArray(r) && r.length === layers[l] && r.every((x) => typeof x === 'number' && Number.isFinite(x)))
        : Array.isArray(m) && m.length === layers[l + 1] && m.every((x: unknown) => typeof x === 'number' && Number.isFinite(x)),
    );
  if (!ok) fail(`state.${k}: shape does not match architecture ${layers.join('→')}`);
}

function checkPoints(v: unknown) {
  if (!Array.isArray(v) || v.length > 64 || !v.every((p) => Array.isArray(p?.x) && p.x.length === 2 && p.x.every((n: unknown) => typeof n === 'number') && (p.y === 0 || p.y === 1)))
    fail('state.points: expected up to 64 items like {"x": [0, 1], "y": 1}');
}

function applyParam(tx: TxBuilder, id: ObjectId, name: string, value: unknown, op: string) {
  const o = tx.get(id);
  if (o.kind === 'glyph') {
    const ex = (o.state.exposed as ExposedParam[]).find((e) => e.name === name);
    if (!ex) fail(`glyph "${o.label}" exposes: ${(o.state.exposed as ExposedParam[]).map((e) => e.name).join(', ') || 'nothing'}`);
    return applyParam(tx, ex!.id, ex!.param, value, op);
  }
  const spec = kindSpec(o.kind)!;
  const ps = spec.params.find((p) => p.name === name);
  if (!ps) fail(`${o.kind} "${o.label}" has no parameter "${name}". Parameters: ${spec.params.map((p) => p.name).join(', ') || 'none'}`);
  const c = coerceParam(ps!, value);
  if (c.error) fail(c.error);
  const params = { ...o.params, [name]: c.value! };
  const state = spec.onParamChange?.({ ...o, params }, name, c.value!);
  tx.modify(id, { params, ...(state ? { state } : {}) }, op);
}

function applyAction(tx: TxBuilder, id: ObjectId, action: unknown, args: unknown, op: string) {
  const o = tx.get(id);
  const spec = kindSpec(o.kind)!;
  const a = typeof action === 'string' ? spec.actions?.[action] : undefined;
  if (!a) fail(`${o.kind} actions: ${Object.keys(spec.actions ?? {}).join(', ') || 'none'}`);
  const given = (args ?? {}) as Record<string, unknown>;
  if (typeof given !== 'object') fail('args: expected an object');
  const vals: Record<string, ParamValue> = {};
  for (const p of a!.args) {
    const v = given[p.name] ?? p.default;
    const c = coerceParam(p, v);
    if (c.error) fail(`${action}: ${c.error}`);
    vals[p.name] = c.value!;
  }
  for (const k of Object.keys(given)) if (!a!.args.some((p) => p.name === k)) fail(`${action}: unknown argument "${k}"`);
  const r = a!.apply(o, vals);
  if (typeof r === 'string') fail(`${action}: ${r}`);
  const res = r as { params?: Record<string, ParamValue>; state?: any };
  tx.modify(id, { ...(res.params ? { params: res.params } : {}), ...(res.state ? { state: res.state } : {}) }, op, String(action));
}

function moveWithMembers(tx: TxBuilder, id: ObjectId, x: number, y: number, op: string) {
  const o = tx.get(id);
  const dx = x - o.visual.x;
  const dy = y - o.visual.y;
  tx.modify(id, { visual: { ...o.visual, x, y } }, op);
  if (o.kind === 'group' || o.kind === 'glyph')
    for (const m of o.state.members as ObjectId[]) {
      const mo = tx.ws.objects[m];
      if (mo) tx.modify(m, { visual: { ...mo.visual, x: mo.visual.x + dx, y: mo.visual.y + dy } }, op);
    }
}

/** train a network and record the run; returns the simulation id */
function executeNetwork(tx: TxBuilder, netId: ObjectId, op: string): ObjectId {
  const net = tx.get(netId);
  if (net.kind !== 'neural_network') fail(`execute: ${net.label} is not a network`);
  const ds = datasetFor(tx.ws, netId);
  if (!ds) fail(`execute: "${net.label}" has no data — connect a dataset to it with feeds_into`);
  const data = points(ds);
  const p = netParams(net);
  const cfg = { learningRate: net.params.learningRate as number, epochs: net.params.epochs as number };
  const result = train(p, data, cfg);
  const config = {
    layers: p.layers,
    activation: p.activation,
    learningRate: cfg.learningRate,
    epochs: cfg.epochs,
    seed: net.params.seed,
    dataset: ds!.id,
    data,
    initial: { weights: p.weights, biases: p.biases },
  };
  const state = { source: netId, config, result };
  const existing = relationsTo(tx.ws, netId, 'generated_from').map((r) => tx.ws.objects[r.from]).find((o) => o?.kind === 'simulation');
  let simId: ObjectId;
  if (existing) {
    simId = existing.id;
    tx.modify(simId, { state }, op);
  } else {
    simId = tx.newId('run');
    tx.createObject(
      {
        id: simId,
        kind: 'simulation',
        label: `Training · ${net.label}`,
        params: {},
        state,
        visual: tx.allocate(sizeFor('simulation'), { below: netId }),
      },
      op,
    );
    tx.relate('generated_from', simId, netId, op);
    tx.modify(simId, { provenance: { ...tx.get(simId).provenance, derivedFrom: [netId, ds!.id] } }, op);
  }
  tx.modify(netId, { state: { ...net.state, weights: result.final.weights, biases: result.final.biases, trainedBy: simId, handEdited: false } }, op, `trained by ${simId}`);
  tx.marker('ComputationExecuted', simId, op, { kind: 'train', finalLoss: result.finalLoss, finalAccuracy: result.finalAccuracy, convergedAt: result.convergedAt });
  const acc = Math.round(result.finalAccuracy * 100);
  tx.notes.push(
    `Trained ${net.label} [${netId}] (${describeArchitecture(p.layers)}, ${p.activation}, lr ${cfg.learningRate}, ${cfg.epochs} epochs, seed ${net.params.seed}) on ${ds!.label}: final loss ${result.finalLoss}, accuracy ${acc}% (${Math.round(result.finalAccuracy * data.length)}/${data.length}), ${result.convergedAt ? `converged at epoch ${result.convergedAt}` : 'did not converge'}. Run: ${simId}.`,
  );
  if (!result.trainable) tx.notes.push('Note: step activation has zero gradient; gradient descent cannot move hidden weights.');
  return simId;
}

function copyObject(tx: TxBuilder, src: TSObject, visual: VisualState, op: string, extra: Partial<TSObject> = {}): TSObject {
  const id = tx.newId(PREFIX[src.kind] ?? 'obj');
  return tx.createObject(
    {
      id,
      kind: src.kind,
      label: src.label,
      params: structuredClone(src.params),
      state: structuredClone(src.state),
      visual,
      ...extra,
      provenance: { derivedFrom: [src.id] },
    },
    op,
  );
}

const nonEmptyArray = (v: unknown, what: string): unknown[] => {
  if (!Array.isArray(v) || v.length === 0) fail(`${what}: expected a non-empty list`);
  return v as unknown[];
};

const str = (v: unknown, what: string, max = 2000): string => {
  if (typeof v !== 'string' || v.trim() === '') fail(`${what}: expected text`);
  if ((v as string).length > max) fail(`${what}: too long (max ${max} characters)`);
  return v as string;
};

const HANDLERS: Record<string, Handler> = {
  create_object(tx, op) {
    const spec = kindSpec(op.kind);
    if (!spec) fail(`unknown kind "${op.kind}". Kinds: ${Object.keys(KINDS).join(', ')}`);
    if (!spec!.creatable)
      fail(`${op.kind} objects are produced by operations (execute, experiment, compare, claim, group, abstract), not create_object`);
    const params = coerceParams(op.kind, op.params);
    const init = checkEditableState({ kind: op.kind, params }, op.state);
    const id = tx.newId(PREFIX[op.kind]);
    const state = spec!.defaultState(params, init);
    const label = op.label !== undefined ? str(op.label, 'label', 80) : defaultLabel(tx.ws, op.kind, params);
    const size = op.kind === 'text' && state.text ? { w: spec!.size.w, h: Math.min(280, 60 + textLines(state.text, 40) * 19) } : spec!.size;
    tx.createObject({ id, kind: op.kind, label, params, state, visual: tx.allocate(size, tx.placement(op.placement)) }, 'create_object');
    tx.setRef(op.ref, id);
    if (op.source !== undefined) {
      if (!['graph', 'equation'].includes(op.kind)) fail('source: only graphs and equations visualize a source');
      const src = tx.id(op.source, 'source');
      tx.relate('visualizes', id, src, 'create_object');
      tx.modify(id, { provenance: { ...tx.get(id).provenance, derivedFrom: [src] } }, 'create_object');
    }
    if (op.dataset !== undefined) {
      if (op.kind !== 'neural_network') fail('dataset: only networks take a dataset');
      HANDLERS.connect(tx, { op: 'connect', from: op.dataset, to: id, relation: 'feeds_into' });
    }
  },

  delete_object(tx, op) {
    const id = tx.id(op.id);
    const o = tx.get(id);
    const doomed = new Set<ObjectId>([id]);
    if (o.kind === 'glyph') for (const m of o.state.members as ObjectId[]) doomed.add(m);
    if (o.kind === 'group') for (const m of o.state.members as ObjectId[]) {
      const mo = tx.ws.objects[m];
      if (mo) tx.modify(m, { parent: undefined }, 'delete_object');
    }
    for (const d of doomed) {
      for (const r of relationsOf(tx.ws, d)) if (tx.ws.relations[r.id]) tx.unrelate(r.id, 'delete_object');
      // detach from containers
      const parent = tx.ws.objects[d]?.parent;
      if (parent && !doomed.has(parent) && tx.ws.objects[parent]) {
        const p = tx.get(parent);
        tx.modify(parent, { state: { ...p.state, members: (p.state.members as ObjectId[]).filter((m) => m !== d) } }, 'delete_object');
      }
      tx.emit({ type: 'ObjectDeleted', id: d, ...tx.base('delete_object') });
    }
  },

  modify_object(tx, op) {
    const id = tx.id(op.id);
    const o = tx.get(id);
    const patch = checkEditableState(o, op.state);
    const set: any = {};
    if (op.label !== undefined) set.label = str(op.label, 'label', 80);
    if (Object.keys(patch).length) {
      set.state = { ...o.state, ...patch };
      if (o.kind === 'neural_network') set.state.handEdited = true;
      if (o.kind === 'dataset' && 'points' in patch) set.params = { ...o.params, preset: 'custom' };
      if (o.kind === 'glyph' && 'name' in patch) set.label = patch.name;
    }
    if (!Object.keys(set).length) fail('modify_object: nothing to change (give label and/or state)');
    tx.modify(id, set, 'modify_object');
  },

  set_parameter(tx, op) {
    applyParam(tx, tx.id(op.id), str(op.param, 'param', 60), op.value, 'set_parameter');
  },

  invoke(tx, op) {
    applyAction(tx, tx.id(op.id), op.action, op.args, 'invoke');
  },

  move_object(tx, op) {
    const id = tx.id(op.id);
    const o = tx.get(id);
    const p = tx.placement(op.placement);
    if (!p) fail('move_object: placement required');
    const v = 'at' in p! ? { ...o.visual, ...p.at } : place({ ...tx.ws, objects: omit(tx.ws.objects, id) }, o.visual, p);
    moveWithMembers(tx, id, v.x, v.y, 'move_object');
  },

  resize_object(tx, op) {
    const id = tx.id(op.id);
    const o = tx.get(id);
    const base = sizeFor(o.kind);
    let w: number, h: number;
    if (typeof op.size === 'string') {
      const f = ({ small: 0.75, medium: 1, large: 1.4 } as Record<string, number>)[op.size];
      if (!f) fail('size: small | medium | large');
      w = Math.round(base.w * f);
      h = Math.round(base.h * f);
    } else if (tx.actor !== 'ai' && typeof op.size?.w === 'number' && typeof op.size?.h === 'number') {
      w = Math.max(120, Math.min(1200, op.size.w));
      h = Math.max(60, Math.min(1000, op.size.h));
    } else return fail('size: small | medium | large');
    tx.modify(id, { visual: { ...o.visual, w: w!, h: h! } }, 'resize_object');
  },

  connect(tx, op) {
    const from = tx.id(op.from, 'from');
    const to = tx.id(op.to, 'to');
    const type = op.relation as RelationType;
    if (!RELATION_TYPES.includes(type)) fail(`relation: one of ${RELATION_TYPES.join(', ')}`);
    if (from === to) fail('connect: an object cannot relate to itself');
    if (Object.values(tx.ws.relations).some((r) => r.from === from && r.to === to && r.type === type)) fail('connect: that relation already exists');
    let a = tx.get(from);
    let b = resolve(tx.ws, to) ?? tx.get(to);
    if (type === 'feeds_into') {
      // data flows one way only; a reversed edge is unambiguous, so straighten it
      const back = resolve(tx.ws, from);
      if (back?.kind === 'neural_network' && tx.get(to).kind === 'dataset') [a, b] = [tx.get(to), back];
      if (a.kind !== 'dataset' || b.kind !== 'neural_network') fail('feeds_into: connects a dataset (data) to a network (data input)');
      for (const r of relationsTo(tx.ws, b.id, 'feeds_into')) tx.unrelate(r.id, 'connect');
      tx.relate('feeds_into', a.id, b.id, 'connect');
      return;
    }
    if (type === 'visualizes') {
      if (!['graph', 'equation'].includes(a.kind)) fail('visualizes: the "from" object must be a graph or equation');
      for (const r of relationsFrom(tx.ws, from, 'visualizes')) tx.unrelate(r.id, 'connect');
    }
    tx.relate(type, from, to, 'connect', op.meta && typeof op.meta === 'object' ? op.meta : undefined);
  },

  disconnect(tx, op) {
    if (op.id) {
      if (!tx.ws.relations[op.id]) fail(`no relation ${op.id}`);
      tx.unrelate(op.id, 'disconnect');
      return;
    }
    const from = tx.id(op.from, 'from');
    const to = tx.id(op.to, 'to');
    const rs = Object.values(tx.ws.relations).filter((r) => r.from === from && r.to === to && (!op.relation || r.type === op.relation));
    if (!rs.length) fail('disconnect: no such relation');
    for (const r of rs) tx.unrelate(r.id, 'disconnect');
  },

  duplicate(tx, op) {
    const src = tx.get(tx.id(op.id));
    if (src.kind === 'glyph' || src.kind === 'group') fail('duplicate: use instantiate_glyph for glyphs');
    const copy = copyObject(tx, src, tx.allocate(src.visual, tx.placement(op.placement) ?? { beside: src.id }), 'duplicate', { label: `${src.label} copy` });
    for (const r of relationsTo(tx.ws, src.id, 'feeds_into')) tx.relate('feeds_into', r.from, copy.id, 'duplicate');
    for (const r of relationsFrom(tx.ws, src.id, 'visualizes')) tx.relate('visualizes', copy.id, r.to, 'duplicate');
    tx.relate('derived_from', copy.id, src.id, 'duplicate');
    tx.setRef(op.ref, copy.id);
  },

  group(tx, op) {
    const ids = nonEmptyArray(op.ids, 'ids').map((v) => tx.id(v));
    for (const i of ids) leaveGroup(tx, i, 'group');
    for (const i of ids) if (tx.get(i).parent) fail(`${i} is inside glyph ${tx.get(i).parent}; group the glyph instead`);
    const bb = bbox(ids.map((i) => tx.get(i)));
    const id = tx.newId('group');
    tx.createObject(
      { id, kind: 'group', label: str(op.label ?? 'Group', 'label', 80), params: {}, state: { members: ids }, visual: { x: bb.x - 20, y: bb.y - 44, w: bb.w + 40, h: bb.h + 64 } },
      'group',
    );
    for (const i of ids) {
      tx.modify(i, { parent: id }, 'group');
      tx.relate('composed_of', id, i, 'group');
    }
    tx.setRef(op.ref, id);
  },

  ungroup(tx, op) {
    const id = tx.id(op.id);
    if (tx.get(id).kind !== 'group') fail('ungroup: not a group');
    HANDLERS.delete_object(tx, { op: 'delete_object', id });
  },

  abstract(tx, op) {
    let ids = [...new Set(nonEmptyArray(op.ids, 'ids').map((v) => tx.id(v)))];
    const name = str(op.name, 'name', 60);
    // data that also feeds objects outside the construction stays outside: it becomes the
    // glyph's data input instead of vanishing from the objects that still depend on it
    const shared = ids.filter((i) => tx.get(i).kind === 'dataset' && relationsFrom(tx.ws, i, 'feeds_into').some((r) => !ids.includes(r.to)));
    if (shared.length && shared.length < ids.length) {
      ids = ids.filter((i) => !shared.includes(i));
      tx.notes.push(`Kept ${shared.map((i) => tx.get(i).label).join(', ')} outside the glyph: other objects still use it, so it feeds the glyph's data input.`);
    }
    // objects framed by a plain group leave that group to join the abstraction
    for (const i of ids) leaveGroup(tx, i, 'abstract');
    const members = ids.map((i) => tx.get(i));
    for (const m of members) {
      if (m.parent) fail(`${m.label} already belongs to ${labelOf(tx.ws, m.parent)}`);
      if (m.kind === 'glyph' || m.kind === 'group') fail('abstract: nesting glyphs/groups is not supported in this prototype');
    }
    const outputId: ObjectId | undefined = op.output !== undefined ? tx.id(op.output, 'output') : members.find((m) => m.kind === 'neural_network')?.id;
    if (outputId && !ids.includes(outputId)) fail('output must be one of the abstracted objects');
    let exposed: ExposedParam[];
    if (op.expose !== undefined) {
      exposed = nonEmptyArray(op.expose, 'expose').map((e: any) => {
        const inner = tx.id(e?.id, 'expose.id');
        if (!ids.includes(inner)) fail(`expose: ${inner} is not part of the construction`);
        const o = tx.get(inner);
        const p = kindSpec(o.kind)!.params.find((q) => q.name === e.param);
        if (!p) fail(`expose: ${o.label} has no parameter "${e.param}"`);
        return { name: typeof e.name === 'string' && e.name ? e.name : e.param, id: inner, param: e.param };
      });
      const names = exposed.map((e) => e.name);
      if (new Set(names).size !== names.length) fail('expose: parameter names must be unique');
    } else {
      exposed = outputId && tx.get(outputId).kind === 'neural_network'
        ? ['hidden', 'activation', 'seed'].map((p) => ({ name: p, id: outputId, param: p }))
        : [];
    }
    const bb = bbox(members);
    const glyphId = tx.newId('glyph');
    const defId = tx.newId('def');
    const internal = Object.values(tx.ws.relations).filter((r) => ids.includes(r.from) && ids.includes(r.to));
    const inputs = Object.values(tx.ws.relations)
      .filter((r) => r.type === 'feeds_into' && ids.includes(r.to) && !ids.includes(r.from))
      .map((r) => ({ member: r.to, from: r.from }));
    const definition: GlyphDefinition = {
      id: defId,
      name,
      description: typeof op.description === 'string' ? op.description : `${name}: ${members.map((m) => m.label).join(', ')}`,
      objects: (() => {
        const packed = pack(members);
        return members.map((m) => ({ ...structuredClone(m), visual: { ...m.visual, ...packed[m.id] } }));
      })(),
      relations: internal.map((r) => structuredClone(r)),
      exposed,
      output: outputId,
      inputs,
      createdBy: tx.actor,
      createdAt: tx.at,
      sourceGlyph: glyphId,
    };
    tx.emit({ type: 'GlyphDefined', definition, ...tx.base('abstract') });
    const size = glyphSize(exposed.length);
    tx.createObject(
      {
        id: glyphId,
        kind: 'glyph',
        label: name,
        params: {},
        state: { name, definition: defId, members: ids, exposed, output: outputId, dataInput: inputs.some((i) => i.member === outputId) || (!!outputId && !datasetFor(tx.ws, outputId)) },
        // the card takes the construction's place, or the nearest free spot to it
        visual: { ...findFree(tx.ws, { x: bb.x, y: bb.y, w: size.w, h: size.h }, new Set(ids)), w: size.w, h: size.h, expanded: false },
        provenance: { derivedFrom: ids, note: 'abstraction; the construction is preserved inside' },
      },
      'abstract',
    );
    for (const m of members) {
      tx.modify(m.id, { parent: glyphId, visual: { ...m.visual, hidden: true } }, 'abstract');
      tx.relate('composed_of', glyphId, m.id, 'abstract');
    }
    // keep the glyph from covering neighbours: it takes the construction's top-left corner
    tx.marker('ObjectAbstracted', glyphId, 'abstract', { members: ids, definition: defId });
    tx.setRef(op.ref, glyphId);
    tx.notes.push(`Abstracted ${ids.length} objects into glyph ${name} [${glyphId}], exposing ${exposed.map((e) => e.name).join(', ') || 'no parameters'}.`);
  },

  expand(tx, op) {
    const id = tx.id(op.id);
    const g = tx.get(id);
    if (g.kind !== 'glyph') fail('expand: only glyphs expand');
    const expanded = typeof op.expanded === 'boolean' ? op.expanded : !g.visual.expanded;
    tx.modify(id, { visual: { ...g.visual, expanded } }, 'expand');
    const members = (g.state.members as ObjectId[]).map((m) => tx.get(m));
    if (expanded) {
      // lay the construction out just below the glyph card
      const packed = pack(members);
      const bb = bbox(members.map((m) => ({ visual: { ...m.visual, ...packed[m.id] } })));
      const spot = findFree(tx.ws, { ...bb, x: g.visual.x, y: g.visual.y + g.visual.h + 40 }, new Set([...members.map((m) => m.id)]));
      for (const m of members) tx.modify(m.id, { visual: { ...m.visual, x: spot.x + packed[m.id].x, y: spot.y + packed[m.id].y, hidden: false } }, 'expand');
    } else for (const m of members) tx.modify(m.id, { visual: { ...m.visual, hidden: true } }, 'expand');
  },

  instantiate_glyph(tx, op) {
    const key = str(op.definition, 'definition', 80);
    const def = tx.ws.glyphs[key] ?? Object.values(tx.ws.glyphs).find((d) => d.name.toLowerCase() === key.toLowerCase());
    if (!def) fail(`no glyph definition "${key}". Library: ${Object.values(tx.ws.glyphs).map((d) => d.name).join(', ') || 'empty'}`);
    const size = glyphSize(def!.exposed.length);
    const v = tx.allocate(size, tx.placement(op.placement));
    const glyphId = tx.newId('glyph');
    const map: Record<string, string> = {};
    for (const o of def!.objects) map[o.id] = tx.newId(PREFIX[o.kind] ?? 'obj');
    for (const o of def!.objects) {
      tx.createObject(
        {
          id: map[o.id],
          kind: o.kind,
          label: o.label,
          params: structuredClone(o.params),
          state: remapState(structuredClone(o.state), map),
          visual: { ...o.visual, x: v.x + o.visual.x, y: v.y + size.h + 40 + o.visual.y, hidden: true },
          parent: glyphId,
          provenance: { derivedFrom: [o.id], note: `from glyph definition ${def!.name}` },
        },
        'instantiate_glyph',
      );
    }
    for (const r of def!.relations) tx.relate(r.type, map[r.from], map[r.to], 'instantiate_glyph', r.meta);
    for (const i of def!.inputs ?? []) if (tx.ws.objects[i.from]) tx.relate('feeds_into', i.from, map[i.member], 'instantiate_glyph');
    const members = def!.objects.map((o) => map[o.id]);
    tx.createObject(
      {
        id: glyphId,
        kind: 'glyph',
        label: def!.name,
        params: {},
        state: {
          name: def!.name,
          definition: def!.id,
          members,
          exposed: def!.exposed.map((e) => ({ ...e, id: map[e.id] })),
          output: def!.output ? map[def!.output] : undefined,
          dataInput: (def!.inputs ?? []).some((i) => i.member === def!.output) || (!!def!.output && !def!.objects.some((o) => o.kind === 'dataset')),
        },
        visual: { ...v, expanded: false },
        provenance: { derivedFrom: [def!.sourceGlyph].filter((x) => tx.ws.objects[x]), note: `instance of ${def!.name}` },
      },
      'instantiate_glyph',
    );
    for (const m of members) {
      tx.relate('composed_of', glyphId, m, 'instantiate_glyph');
    }
    if (tx.ws.objects[def!.sourceGlyph]) tx.relate('instance_of', glyphId, def!.sourceGlyph, 'instantiate_glyph');
    tx.setRef(op.ref, glyphId);
  },

  execute(tx, op) {
    const id = tx.id(op.id);
    const o = tx.get(id);
    if (o.kind === 'experiment') return HANDLERS.reproduce(tx, op);
    const target = resolve(tx.ws, id)!;
    tx.setRef(op.ref, executeNetwork(tx, target.id, 'execute'));
  },

  plot(tx, op) {
    const src = tx.id(op.source, 'source');
    const s = resolve(tx.ws, src)!;
    const mode = op.mode ?? (s.kind === 'simulation' ? 'loss_curve' : s.kind === 'function' ? 'activation' : 'decision_boundary');
    const params = coerceParams('graph', { mode, ...(op.weight !== undefined ? { weight: op.weight } : {}), ...(op.span !== undefined ? { span: op.span } : {}) });
    if (mode === 'decision_boundary' && s.kind !== 'neural_network') fail('decision_boundary plots need a network source');
    if (mode === 'weight_sweep') {
      if (s.kind !== 'neural_network') fail('weight_sweep plots need a network source');
      const [l, j, i] = String(params.weight).split(':').map(Number);
      if (s.state.weights[l]?.[j]?.[i] === undefined) fail(`weight ${params.weight} does not exist in ${describeArchitecture(layersOf(s))}`);
    }
    const id = tx.newId('plot');
    const label = typeof op.label === 'string' ? op.label : mode === 'weight_sweep' ? `Sensitivity of w${params.weight}` : mode === 'loss_curve' ? 'Loss' : `Decision boundary · ${s.label}`;
    tx.createObject(
      { id, kind: 'graph', label, params, state: {}, visual: tx.allocate(sizeFor('graph'), tx.placement(op.placement) ?? { beside: src }), provenance: { derivedFrom: [src] } },
      'plot',
    );
    tx.relate('visualizes', id, src, 'plot');
    tx.setRef(op.ref, id);
  },

  zoom_into(tx, op) {
    const src = tx.id(op.id);
    const s = resolve(tx.ws, src)!;
    if (s.kind !== 'neural_network') fail('zoom_into: currently defined for networks (neuron → equation → arithmetic)');
    const form = op.form ?? 'neuron';
    const focus = op.focus ?? `${layersOf(s).length - 1}:0`;
    const [L, J] = String(focus).split(':').map(Number);
    if (['neuron', 'arithmetic'].includes(form) && (!(L >= 1) || s.state.weights[L - 1]?.[J] === undefined)) fail(`zoom_into: no neuron ${focus} (layers ${describeArchitecture(layersOf(s))}; L starts at 1)`);
    const params = coerceParams('equation', { form, focus, ...(op.input !== undefined ? { input: String(op.input) } : {}) });
    const id = tx.newId('eq');
    const label = form === 'boundary' ? `Boundary of ${s.label}` : form === 'network' ? `${s.label} as a function` : form === 'arithmetic' ? `Neuron ${focus} on input (${params.input})` : `Neuron ${focus}`;
    tx.createObject(
      { id, kind: 'equation', label, params, state: { latex: '' }, visual: tx.allocate(sizeFor('equation'), tx.placement(op.placement) ?? { below: src }), provenance: { derivedFrom: [src] } },
      'zoom_into',
    );
    tx.relate('visualizes', id, src, 'zoom_into');
    tx.setRef(op.ref, id);
  },

  experiment(tx, op) {
    const target = resolve(tx.ws, tx.id(op.target, 'target'))!;
    if (target.kind !== 'neural_network') fail('experiment: target must be a network (or a glyph wrapping one)');
    const ds = datasetFor(tx.ws, target.id);
    if (!ds) fail('experiment: target has no dataset');
    const h = op.hypothesis;
    const hypothesis = { text: str(typeof h === 'string' ? h : h?.text, 'hypothesis.text', 400), expect: [] as Expectation[] };
    if (h && typeof h === 'object' && h.expect !== undefined) {
      hypothesis.expect = nonEmptyArray(h.expect, 'hypothesis.expect').map((e: any) => {
        if (e && typeof e === 'object') {
          e = { ...e, metric: METRIC_ALIASES[e.metric] ?? e.metric, op: OP_ALIASES[e.op] ?? e.op };
          if (typeof e.threshold === 'string' && e.threshold.trim() !== '' && Number.isFinite(Number(e.threshold))) e.threshold = Number(e.threshold);
        }
        if (!METRICS.includes(e?.metric)) fail(`expect.metric: one of ${METRICS.join(', ')}`);
        if (!['<', '<=', '>', '>=', '=='].includes(e?.op)) fail('expect.op: < <= > >= ==');
        if (e.than === undefined && typeof e?.threshold !== 'number') fail('expect: give a numeric threshold, or "than": another value of the variable to compare with');
        return { ...(e.value !== undefined ? { value: e.value } : {}), metric: e.metric, op: e.op, ...(e.than !== undefined ? { than: e.than } : { threshold: e.threshold }) };
      });
    }
    const variable = op.variable;
    const allowed = ['hidden', 'activation', 'learningRate', 'epochs'];
    if (!variable || !allowed.includes(variable.param)) fail(`variable.param: one of ${allowed.join(', ')}`);
    const spec = kindSpec('neural_network')!.params.find((p) => p.name === variable.param)!;
    const values = nonEmptyArray(variable.values, 'variable.values').map((v) => {
      const c = coerceParam(spec, v);
      if (c.error) fail(`variable.values: ${c.error}`);
      return c.value;
    });
    if (values.length > 6) fail('variable.values: at most 6 values');
    const seeds = op.seeds === undefined ? [1, 2, 3, 4, 5, 6] : nonEmptyArray(op.seeds, 'seeds').map((s) => (Number.isInteger(s) ? (s as number) : fail('seeds: integers')));
    if (seeds.length > 12) fail('seeds: at most 12');
    const known = (v: unknown) => values.some((x) => JSON.stringify(x) === JSON.stringify(coerceParam(spec, v).value));
    for (const e of hypothesis.expect) {
      if (e.value !== undefined && !known(e.value)) fail(`expect.value ${JSON.stringify(e.value)} is not one of the variable's values`);
      if (e.than !== undefined && !known(e.than)) fail(`expect.than ${JSON.stringify(e.than)} is not one of the variable's values`);
    }
    hypothesis.expect = hypothesis.expect.map((e) => ({
      ...e,
      ...(e.value !== undefined ? { value: coerceParam(spec, e.value).value } : {}),
      ...(e.than !== undefined ? { than: coerceParam(spec, e.than).value } : {}),
    }));

    const xspec: ExperimentSpec = {
      target: target.id,
      hypothesis,
      variable: { param: variable.param, values },
      baseline: {
        hidden: target.params.hidden as number[],
        activation: target.params.activation as any,
        learningRate: target.params.learningRate as number,
        epochs: Math.min(target.params.epochs as number, 5000),
      },
      seeds,
      data: points(ds),
      datasetId: ds!.id,
    };
    const id = tx.newId('exp');
    tx.marker('ExperimentStarted', target.id, 'experiment', { experiment: id, variable: xspec.variable });
    const outcome = runExperiment(xspec);
    tx.createObject(
      {
        id,
        kind: 'experiment',
        label: typeof op.label === 'string' ? op.label : `Experiment: vary ${variable.param}`,
        params: {},
        state: { ...xspec, ...outcome, measures: outcome.measures, reproductions: [] },
        visual: tx.allocate(sizeFor('experiment'), tx.placement(op.placement) ?? { beside: target.id }),
        provenance: { derivedFrom: [target.id, ds!.id], experiment: id },
      },
      'experiment',
    );
    tx.relate('generated_from', id, target.id, 'experiment');
    tx.marker('ExperimentCompleted', id, 'experiment', { supported: outcome.supported, hash: outcome.hash });
    tx.setRef(op.ref, id);
    tx.notes.push(`Experiment ${id}: ${outcome.conclusion} (results hash ${outcome.hash})`);
    for (const r of outcome.results)
      tx.notes.push(`  ${formatValue(r.value)} → success ${Math.round((r.summary.success_rate ?? 0) * 100)}%, mean loss ${r.summary.mean_final_loss}, best acc ${Math.round((r.summary.best_accuracy ?? 0) * 100)}%, mean converged at ${r.summary.mean_converged_at ?? '—'}`);
  },

  reproduce(tx, op) {
    const id = tx.id(op.id);
    const e = tx.get(id);
    if (e.kind !== 'experiment') fail('reproduce: not an experiment');
    const s = e.state;
    const again = runExperiment({ target: s.target, hypothesis: s.hypothesis, variable: s.variable, baseline: s.baseline, seeds: s.seeds, data: s.data, datasetId: s.datasetId });
    const match = again.hash === s.hash;
    tx.modify(id, { state: { ...s, reproductions: [...(s.reproductions ?? []), { at: tx.at, hash: again.hash, match, by: tx.actor }] } }, 'reproduce');
    tx.marker('ComputationExecuted', id, 'reproduce', { kind: 'reproduce', match, hash: again.hash });
    tx.notes.push(match ? `Reproduced ${id}: identical results (hash ${again.hash}).` : `Reproduction of ${id} DIFFERED: ${again.hash} vs ${s.hash}.`);
  },

  branch(tx, op) {
    const ids = [...new Set(nonEmptyArray(op.ids, 'ids').map((v) => resolve(tx.ws, tx.id(v))!.id))];
    const assumption = str(op.assumption, 'assumption', 200);
    const originals = ids.map((i) => tx.get(i));
    for (const o of originals) if (['glyph', 'group', 'comparison', 'experiment', 'claim'].includes(o.kind)) fail(`branch: cannot branch a ${o.kind} (branch the objects it refers to)`);
    const bb = bbox(originals);
    const { dx, dy } = placeBlock(tx.ws, bb, op.direction === 'below' ? 'below' : 'right');
    const map: Record<string, string> = {};
    for (const o of originals) {
      const copy = copyObject(tx, o, { ...o.visual, x: o.visual.x + dx, y: o.visual.y + dy, hidden: false }, 'branch', {
        label: typeof op.label === 'string' && o.kind === 'neural_network' ? op.label : o.kind === 'neural_network' ? `${o.label} · ${shortAssumption(assumption)}` : o.label,
        parent: undefined,
      });
      map[o.id] = copy.id;
      tx.modify(copy.id, { provenance: { ...tx.get(copy.id).provenance, assumption } }, 'branch');
      tx.relate('branched_from', copy.id, o.id, 'branch', { assumption });
    }
    // re-create relations: internal ones between copies, external data/sources shared
    for (const r of Object.values(tx.ws.relations)) {
      const f = map[r.from];
      const t = map[r.to];
      if (r.type === 'branched_from' || r.type === 'composed_of') continue;
      if (f && t) tx.relate(r.type, f, t, 'branch', r.meta);
      else if (!f && t && r.type === 'feeds_into') tx.relate('feeds_into', r.from, t, 'branch');
      else if (f && !t && r.type === 'visualizes') tx.relate('visualizes', f, r.to, 'branch');
    }
    if (op.changes !== undefined)
      for (const c of nonEmptyArray(op.changes, 'changes') as any[]) {
        const orig = resolve(tx.ws, tx.id(c?.id, 'changes.id'))!.id;
        const target = map[orig];
        if (!target) fail(`changes: ${orig} is not part of the branch`);
        if (c.param !== undefined) applyParam(tx, target, c.param, c.value, 'branch');
        else if (c.action !== undefined) applyAction(tx, target, c.action, c.args, 'branch');
        else fail('changes: each change needs param+value or action+args');
      }
    if (op.execute) for (const o of originals) if (o.kind === 'neural_network') executeNetwork(tx, map[o.id], 'branch');
    tx.marker('VariantCreated', map[ids[0]], 'branch', { assumption, map });
    if (op.ref !== undefined) {
      const net = originals.find((o) => o.kind === 'neural_network') ?? originals[0];
      tx.setRef(op.ref, map[net.id]);
    }
    tx.notes.push(`Branched (${assumption}): ${Object.entries(map).map(([a, b]) => `${a} → ${b}`).join(', ')}.`);
  },

  compare(tx, op) {
    const a = tx.id(op.a, 'a');
    const b = tx.id(op.b, 'b');
    if (a === b) fail('compare: pick two different objects');
    const id = tx.newId('cmp');
    const A = tx.get(a);
    const B = tx.get(b);
    const below = A.visual.y + A.visual.h > B.visual.y + B.visual.h ? a : b;
    tx.createObject(
      {
        id,
        kind: 'comparison',
        label: typeof op.label === 'string' ? op.label : `${A.label} vs ${B.label}`,
        params: {},
        state: { a, b },
        visual: tx.allocate(sizeFor('comparison'), tx.placement(op.placement) ?? { below }),
        provenance: { derivedFrom: [a, b] },
      },
      'compare',
    );
    tx.relate('compares_with', id, a, 'compare');
    tx.relate('compares_with', id, b, 'compare');
    tx.marker('BranchCompared', id, 'compare', { a, b });
    tx.setRef(op.ref, id);
  },

  annotate(tx, op) {
    const target = tx.id(op.target, 'target');
    const text = str(op.text, 'text', 1200);
    const id = tx.newId('note');
    const t = tx.get(target);
    tx.createObject(
      {
        id,
        kind: 'text',
        label: typeof op.label === 'string' ? op.label : `On ${t.label}`,
        params: {},
        state: { text, subtarget: typeof op.subtarget === 'string' ? op.subtarget : undefined },
        visual: tx.allocate({ w: 300, h: Math.min(300, 64 + textLines(text, 42) * 19) }, tx.placement(op.placement) ?? { beside: target }),
        provenance: { derivedFrom: [target] },
      },
      'annotate',
    );
    tx.relate('annotates', id, target, 'annotate', op.subtarget ? { subtarget: op.subtarget } : undefined);
    tx.marker('Annotated', target, 'annotate', { note: id });
    tx.setRef(op.ref, id);
  },

  claim(tx, op) {
    const text = str(op.text, 'text', 400);
    const about = op.about === undefined ? [] : (Array.isArray(op.about) ? op.about : [op.about]).map((v: unknown) => tx.id(v, 'about'));
    const id = tx.newId('claim');
    tx.createObject(
      {
        id,
        kind: 'claim',
        label: 'Claim',
        params: {},
        state: { text, status: 'unverified', about, evidence: [] },
        visual: tx.allocate(sizeFor('claim'), tx.placement(op.placement) ?? (about[0] ? { below: about[0] } : undefined)),
        provenance: { derivedFrom: about },
      },
      'claim',
    );
    tx.marker('ClaimGenerated', id, 'claim', { text });
    tx.setRef(op.ref, id);
  },

  verify_claim(tx, op) {
    const id = tx.id(op.claim, 'claim');
    const c = tx.get(id);
    if (c.kind !== 'claim') fail('verify_claim: not a claim');
    const ev = tx.get(tx.id(Array.isArray(op.evidence) && op.evidence.length === 1 ? op.evidence[0] : op.evidence, 'evidence'));
    if (ev.kind !== 'experiment') fail('verify_claim: evidence must be an experiment (a deterministic, reproducible computation)');
    if (ev.state.supported === null || ev.state.supported === undefined)
      fail(`verify_claim: ${ev.id} is inconclusive — its hypothesis has no testable expectations. Run an experiment with hypothesis.expect (e.g. {"value": [2], "metric": "success_rate", "op": ">", "than": []})`);
    const status = ev.state.supported ? 'supported' : 'refuted';
    tx.modify(id, { state: { ...c.state, status, evidence: [...new Set([...(c.state.evidence as string[]), ev.id])] }, provenance: { ...c.provenance, verifiedBy: [...new Set([...c.provenance.verifiedBy, ev.id])] } }, 'verify_claim');
    tx.relate('verified_by', id, ev.id, 'verify_claim');
    tx.marker('ClaimVerified', id, 'verify_claim', { evidence: ev.id, status, hypothesis: ev.state.hypothesis.text });
    tx.notes.push(`Claim ${id} is now ${status} by ${ev.id} (hypothesis: "${ev.state.hypothesis.text}").`);
  },
};

/** take an object out of the plain group framing it (glyph membership is never undone implicitly) */
function leaveGroup(tx: TxBuilder, id: ObjectId, op: string) {
  const parent = tx.ws.objects[tx.get(id).parent ?? ''];
  if (parent?.kind !== 'group') return;
  tx.modify(parent.id, { state: { ...parent.state, members: (parent.state.members as ObjectId[]).filter((m) => m !== id) } }, op);
  for (const r of relationsFrom(tx.ws, parent.id, 'composed_of')) if (r.to === id) tx.unrelate(r.id, op);
  tx.modify(id, { parent: undefined }, op);
}

function glyphSize(exposed: number) {
  const base = sizeFor('glyph');
  return { w: base.w, h: Math.max(base.h, 196 + 25 * exposed) };
}

function omit<T>(r: Record<string, T>, k: string): Record<string, T> {
  const c = { ...r };
  delete c[k];
  return c;
}

function remapState(state: any, map: Record<string, string>): any {
  if (typeof state === 'string') return map[state] ?? state;
  if (Array.isArray(state)) return state.map((s) => remapState(s, map));
  if (state && typeof state === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(state)) out[k] = k === 'weights' || k === 'biases' || k === 'points' ? v : remapState(v, map);
    return out;
  }
  return state;
}

function textLines(text: string, perLine: number): number {
  return text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
}

function shortAssumption(a: string): string {
  return a.length > 28 ? a.slice(0, 27) + '…' : a;
}

function defaultLabel(ws: Workspace, kind: string, params: Record<string, ParamValue>): string {
  const n = Object.values(ws.objects).filter((o) => o.kind === kind).length + 1;
  switch (kind) {
    case 'neural_network':
      return `Network ${String.fromCharCode(64 + Math.min(26, n))}`;
    case 'dataset':
      return `${String(params.preset).toUpperCase()} data`;
    case 'graph':
      return `Plot ${n}`;
    case 'function':
      return `${params.fn}(x)`;
    case 'equation':
      return `Equation ${n}`;
    case 'text':
      return `Note ${n}`;
    default:
      return `${kind} ${n}`;
  }
}
