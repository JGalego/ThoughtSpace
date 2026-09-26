// Deterministic "noticers": they look at the semantic graph and propose small, contextual
// next steps attached to specific objects. They never act on their own.

import type { ObjectId, Operation, Workspace } from './types';
import { linearlySeparable, sensitivities } from './nn';
import { variablesBehind } from './calc';
import { datasetFor, layersOf, netParams, networkMetrics, networks, points, plotsOf, relationsFrom, relationsTo } from './semantics';

export interface Suggestion {
  /** stable key so a dismissal sticks */
  key: string;
  target: ObjectId;
  text: string;
  label: string;
  action: { kind: 'ops'; ops: Operation[] } | { kind: 'ask'; text: string; selection: ObjectId[] };
}

export function suggestions(ws: Workspace): Suggestion[] {
  const out: Suggestion[] = [];
  const nets = networks(ws).filter((n) => !n.visual.hidden);

  for (const net of nets) {
    const ds = datasetFor(ws, net.id);
    if (!ds) {
      out.push({ key: `nodata:${net.id}`, target: net.id, text: 'This network has no data yet.', label: 'Give it XOR', action: { kind: 'ops', ops: [{ op: 'create_object', kind: 'dataset', params: { preset: 'xor' }, ref: 'd', placement: { left_of: net.id } }, { op: 'connect', from: '$d', to: net.id, relation: 'feeds_into' }] } });
      continue;
    }
    const m = networkMetrics(ws, net)!;
    const sep = linearlySeparable(points(ds));
    const hidden = (net.params.hidden as number[]).length;

    if (!plotsOf(ws, net.id).some((p) => p.params.mode === 'decision_boundary'))
      out.push({ key: `plot:${net.id}`, target: net.id, text: 'See what this network believes about the whole input space.', label: 'Plot decision boundary', action: { kind: 'ops', ops: [{ op: 'plot', source: net.id, mode: 'decision_boundary' }] } });

    if (!net.state.trainedBy && !net.state.handEdited && m.accuracy < 1)
      out.push({ key: `train:${net.id}:${JSON.stringify(net.params)}`, target: net.id, text: 'Untrained. Let gradient descent have a go?', label: 'Train', action: { kind: 'ops', ops: [{ op: 'execute', id: net.id }] } });

    if (net.state.trainedBy && m.accuracy < 1 && hidden === 0 && !sep) {
      out.push({ key: `why:${net.id}`, target: net.id, text: `Stuck at ${Math.round(m.accuracy * 100)}%. A single neuron can only draw one straight line.`, label: 'Why?', action: { kind: 'ask', text: "Why doesn't this one work?", selection: [net.id] } });
      if (!relationsFrom(ws, net.id, 'branched_from').length && !relationsTo(ws, net.id, 'branched_from').length)
        out.push({ key: `fix:${net.id}`, target: net.id, text: 'Search for the smallest change that works?', label: 'Smallest fix', action: { kind: 'ask', text: 'Show me the smallest change that makes it work.', selection: [net.id] } });
    }

    if (net.state.trainedBy && m.accuracy === 1) {
      const s = sensitivities(netParams(net), points(ds))[0];
      if (s && s.accuracyFlips && s.score > 0.4 && !plotsOf(ws, net.id).some((p) => p.params.mode === 'weight_sweep'))
        out.push({ key: `sens:${net.id}:${s.path.join(':')}`, target: net.id, text: `w${s.path.join(':')} is unusually sensitive — nudging it by 0.5 changes the answer.`, label: 'Visualize its effect', action: { kind: 'ops', ops: [{ op: 'plot', source: net.id, mode: 'weight_sweep', weight: s.path.join(':') }] } });
      if (!net.parent && layersOf(net).length > 2)
        out.push({ key: `glyph:${net.id}`, target: net.id, text: 'This construction works. Make it reusable?', label: 'Make a glyph', action: { kind: 'ask', text: 'Turn this into a reusable glyph.', selection: [net.id] } });
    }
  }

  // variants that have never been compared (most relevant: shown first)
  const first: Suggestion[] = [];
  for (const r of Object.values(ws.relations)) {
    if (r.type !== 'branched_from') continue;
    const a = ws.objects[r.to];
    const b = ws.objects[r.from];
    if (!a || !b || !['neural_network', 'formula', 'system', 'trials'].includes(a.kind) || a.visual.hidden || b.visual.hidden) continue;
    const compared = Object.values(ws.objects).some((o) => o.kind === 'comparison' && [o.state.a, o.state.b].includes(a.id) && [o.state.a, o.state.b].includes(b.id));
    if (!compared)
      first.push({ key: `cmp:${a.id}:${b.id}`, target: b.id, text: `Branched from ${a.label}${r.meta?.assumption ? ` (${r.meta.assumption})` : ''}.`, label: 'Compare branches', action: { kind: 'ops', ops: [{ op: 'compare', a: a.id, b: b.id }] } });
  }

  // networks with different activations side by side
  const trained = nets.filter((n) => n.state.trainedBy);
  for (let i = 0; i < trained.length; i++)
    for (let j = i + 1; j < trained.length; j++) {
      const a = trained[i];
      const b = trained[j];
      if (a.params.activation !== b.params.activation && JSON.stringify(a.params.hidden) === JSON.stringify(b.params.hidden) && (a.params.hidden as number[]).length > 0)
        out.push({ key: `act:${a.id}:${b.id}`, target: b.id, text: `Same architecture, ${a.params.activation} vs ${b.params.activation}.`, label: 'Compare activations', action: { kind: 'ops', ops: [{ op: 'compare', a: a.id, b: b.id }] } });
    }

  // open lessons: a live quantity nobody has looked at as a picture yet
  for (const o of Object.values(ws.objects)) {
    if (o.visual.hidden || !['formula', 'system', 'trials'].includes(o.kind) || relationsTo(ws, o.id, 'visualizes').length) continue;
    if (relationsFrom(ws, o.id, 'feeds_into').length && o.kind === 'formula') continue; // an intermediate step
    if (o.kind === 'formula' && variablesBehind(ws, o.id).length)
      out.push({ key: `curve:${o.id}`, target: o.id, text: `How does ${o.state.name} change as ${variablesBehind(ws, o.id)[0].state.name} moves?`, label: 'Plot it', action: { kind: 'ops', ops: [{ op: 'plot', source: o.id }] } });
    if (o.kind === 'system') out.push({ key: `series:${o.id}`, target: o.id, text: 'Watch it unfold over time.', label: 'Plot over time', action: { kind: 'ops', ops: [{ op: 'plot', source: o.id }] } });
    if (o.kind === 'trials') out.push({ key: `hist:${o.id}`, target: o.id, text: 'What does the spread of outcomes look like?', label: 'Histogram', action: { kind: 'ops', ops: [{ op: 'plot', source: o.id }] } });
  }

  // unverified claims
  for (const c of Object.values(ws.objects))
    if (c.kind === 'claim' && c.state.status === 'unverified' && !c.visual.hidden)
      out.push({ key: `verify:${c.id}`, target: c.id, text: 'Unverified. Claims need evidence before they count.', label: 'Test it', action: { kind: 'ask', text: 'Run an experiment to test this claim.', selection: [c.id] } });

  return [...first, ...out];
}
