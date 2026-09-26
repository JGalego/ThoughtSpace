// Read-only queries over the semantic graph. These are the kernel's "understanding"
// of how objects relate; renderers, suggestions and agents all use them.

import type { ObjectId, Relation, RelationType, TSObject, Workspace } from './types';
import { evaluate, type Activation, type Metrics, type NetParams, type Point } from './nn';

export function obj(ws: Workspace, id: ObjectId | undefined | null): TSObject | undefined {
  return id ? ws.objects[id] : undefined;
}

export function relationsFrom(ws: Workspace, id: ObjectId, type?: RelationType): Relation[] {
  return Object.values(ws.relations).filter((r) => r.from === id && (!type || r.type === type));
}

export function relationsTo(ws: Workspace, id: ObjectId, type?: RelationType): Relation[] {
  return Object.values(ws.relations).filter((r) => r.to === id && (!type || r.type === type));
}

export function relationsOf(ws: Workspace, id: ObjectId): Relation[] {
  return Object.values(ws.relations).filter((r) => r.from === id || r.to === id);
}

/** Follow glyph indirection: a glyph stands for its output object. */
export function resolve(ws: Workspace, id: ObjectId | undefined): TSObject | undefined {
  let o = obj(ws, id);
  let guard = 0;
  while (o && o.kind === 'glyph' && o.state.output && guard++ < 8) o = obj(ws, o.state.output);
  return o;
}

/** The object a graph/equation/comparison visualizes. */
export function sourceOf(ws: Workspace, id: ObjectId): TSObject | undefined {
  const r = relationsFrom(ws, id, 'visualizes')[0];
  return r ? resolve(ws, r.to) : undefined;
}

export function datasetFor(ws: Workspace, netId: ObjectId): TSObject | undefined {
  const r = relationsTo(ws, netId, 'feeds_into').find((r) => ws.objects[r.from]?.kind === 'dataset');
  return r ? ws.objects[r.from] : undefined;
}

export function points(ds: TSObject | undefined): Point[] {
  return ds ? (ds.state.points as Point[]) : [];
}

export function layersOf(net: TSObject): number[] {
  return [net.state.inputs ?? 2, ...((net.params.hidden as number[]) ?? []), 1];
}

export function netParams(net: TSObject): NetParams {
  return {
    layers: layersOf(net),
    weights: net.state.weights,
    biases: net.state.biases,
    activation: net.params.activation as Activation,
  };
}

export function networkMetrics(ws: Workspace, net: TSObject): (Metrics & { dataset?: ObjectId }) | undefined {
  const ds = datasetFor(ws, net.id);
  if (!ds) return undefined;
  return { ...evaluate(netParams(net), points(ds)), dataset: ds.id };
}

export function visibleObjects(ws: Workspace): TSObject[] {
  return Object.values(ws.objects).filter((o) => !o.visual.hidden);
}

export function networks(ws: Workspace): TSObject[] {
  return Object.values(ws.objects).filter((o) => o.kind === 'neural_network');
}

export function plotsOf(ws: Workspace, id: ObjectId): TSObject[] {
  return relationsTo(ws, id, 'visualizes')
    .map((r) => ws.objects[r.from])
    .filter((o): o is TSObject => !!o);
}

/** The construction around an object: its data, its views, the things it derives from. */
export function neighbourhood(ws: Workspace, id: ObjectId): ObjectId[] {
  const out = new Set<ObjectId>([id]);
  const o = ws.objects[id];
  if (!o) return [];
  if (o.kind === 'neural_network') {
    const ds = datasetFor(ws, id);
    if (ds) out.add(ds.id);
    for (const p of plotsOf(ws, id)) out.add(p.id);
  }
  return [...out];
}

export function describeArchitecture(layers: number[]): string {
  return layers.join('→');
}

export function labelOf(ws: Workspace, id: ObjectId): string {
  const o = ws.objects[id];
  return o ? o.label : id;
}
