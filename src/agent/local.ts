// The offline planner: a deterministic participant that understands a small vocabulary of
// intents and turns them into the same typed operations Claude would emit. It lets the
// canonical journey run with no network access, and doubles as an executable spec.

import type { Agent, AgentHost } from './host';
import {
  datasetFor,
  describeArchitecture,
  formatValue,
  kindSpec,
  layersOf,
  netParams,
  networkMetrics,
  networks,
  nn,
  plotsOf,
  points,
  relationsFrom,
  relationsTo,
  resolve,
  smallestWorking,
  sourceOf,
  type ObjectId,
  type Operation,
  type TSObject,
  type Workspace,
} from '../kernel';

const ACTS = ['relu', 'tanh', 'sigmoid', 'step', 'linear'];

export const localAgent: Agent = {
  name: 'offline planner',
  async run(text, host) {
    const t = text.toLowerCase().trim();
    const ctx = new Ctx(host);
    for (const intent of INTENTS) {
      if (intent.match(t, ctx)) {
        await intent.run(t, ctx, text);
        return;
      }
    }
    host.say(
      "I'm the offline planner, so I only understand a small vocabulary: build an XOR exploration, train, add/remove a layer, switch activation, plot, zoom into a neuron, why doesn't this work, smallest change that works, experiment, what if …, compare, sensitivity, turn into a glyph. Connect Claude (⚙) for open-ended requests.",
    );
  },
};

class Ctx {
  constructor(readonly host: AgentHost) {}
  get ws(): Workspace {
    return this.host.kernel.state();
  }
  get sel(): ObjectId[] {
    return this.host.selection().filter((id) => this.ws.objects[id]);
  }

  /** "this network": whatever the selection points at, else the only/latest network */
  net(): TSObject | undefined {
    for (const id of this.sel) {
      const n = netFor(this.ws, id);
      if (n) return n;
    }
    const nets = networks(this.ws).filter((n) => !n.visual.hidden);
    return nets.sort((a, b) => idNum(b.id) - idNum(a.id))[0] ?? networks(this.ws).sort((a, b) => idNum(b.id) - idNum(a.id))[0];
  }

  apply(ops: Operation[], summary?: string) {
    const r = this.host.apply(ops, summary);
    if (!r.ok) this.host.say(`That didn't validate: ${r.errors.join('; ')}`);
    return r;
  }
}

const idNum = (id: string) => Number(id.split('_').pop()) || 0;

function netFor(ws: Workspace, id: ObjectId): TSObject | undefined {
  const o = ws.objects[id];
  if (!o) return;
  if (o.kind === 'neural_network') return o;
  if (o.kind === 'glyph') return resolve(ws, id)?.kind === 'neural_network' ? resolve(ws, id) : undefined;
  if (o.kind === 'graph' || o.kind === 'equation') return sourceOf(ws, id)?.kind === 'neural_network' ? sourceOf(ws, id) : undefined;
  if (o.kind === 'simulation') return ws.objects[o.state.source];
  if (o.kind === 'experiment') return ws.objects[o.state.target];
  if (o.kind === 'comparison') return ws.objects[o.state.b] ?? ws.objects[o.state.a];
  if (o.kind === 'claim') return (o.state.about as string[]).map((a) => netFor(ws, a)).find(Boolean);
  if (o.kind === 'dataset') {
    const r = relationsFrom(ws, id, 'feeds_into')[0];
    return r ? ws.objects[r.to] : undefined;
  }
  if (o.kind === 'text') {
    const r = relationsFrom(ws, id, 'annotates')[0];
    return r ? netFor(ws, r.to) : undefined;
  }
}

interface Intent {
  match(t: string, c: Ctx): boolean;
  run(t: string, c: Ctx, raw: string): Promise<void> | void;
}

const needNet = (c: Ctx): TSObject | undefined => {
  const n = c.net();
  if (!n) c.host.say('There is no network here yet. Try "Let\'s understand why XOR requires a hidden layer."');
  return n;
};

const INTENTS: Intent[] = [
  // ---------------------------------------------------------------- construct
  {
    match: (t, c) => /\bxor\b/.test(t) && (networks(c.ws).length === 0 || /\b(understand|explore|build|start|why does|requires?|need)\b/.test(t)) && !/smallest|glyph|compare/.test(t),
    run(_t, c) {
      c.host.status('constructing…');
      const r = c.apply(
        [
          { op: 'create_object', kind: 'text', ref: 'q', label: 'Question', state: { text: 'Why does XOR require a hidden layer?\n\nXOR is 1 when exactly one input is 1. Below: the data, the simplest possible network, and what it computes.' } },
          { op: 'create_object', kind: 'dataset', ref: 'data', label: 'XOR', params: { preset: 'xor' }, placement: { below: '$q' } },
          { op: 'create_object', kind: 'neural_network', ref: 'net', label: 'Single neuron', params: { hidden: [] }, placement: { beside: '$data' }, dataset: '$data' },
          { op: 'plot', source: '$net', mode: 'decision_boundary', ref: 'plot', placement: { beside: '$net' } },
          { op: 'zoom_into', id: '$net', form: 'neuron', focus: '1:0', ref: 'eq', placement: { below: '$net' } },
          { op: 'claim', text: 'A single neuron cannot represent XOR.', about: ['$net'], ref: 'claim', placement: { below: '$plot' } },
        ],
        'construct XOR exploration',
      );
      if (!r.ok) return;
      c.host.focus(r.created);
      c.host.highlight([`${r.refs.net}`, `${r.refs.plot}`], 'drag the weights; watch the line');
      c.host.say(
        'I built a small world: the XOR data, a single neuron fed by it, its decision boundary, and its equation with live weights. The claim below is unverified. Drag a weight on the network (or click a data point to change the problem) and watch the boundary move — then train it, or ask me why it fails.',
      );
    },
  },

  // ------------------------------------------------------------ smallest fix
  {
    match: (t) => /(smallest|minimal|simplest|least) (change|fix|modification)|make (it|this) work/.test(t),
    run(_t, c) {
      const net = needNet(c);
      if (!net) return;
      const ds = datasetFor(c.ws, net.id);
      if (!ds) return c.host.say(`${net.label} has no data to work on.`);
      const hidden = net.params.hidden as number[];
      const separable = nn.linearlySeparable(points(ds));
      c.host.status('searching architectures…');
      let values: unknown[];
      let expect: any[];
      let hyp: string;
      if (hidden.length === 0 && !separable) {
        values = [[], [1], [2], [3]];
        hyp = 'No network without a hidden layer (or with a single hidden unit) solves this data; two hidden units can.';
        expect = [
          { value: [], metric: 'success_rate', op: '==', threshold: 0 },
          { value: [1], metric: 'success_rate', op: '==', threshold: 0 },
          { value: [2], metric: 'success_rate', op: '>', threshold: 0 },
        ];
      } else {
        values = hidden.length === 0 ? [[], [1], [2]] : dedupe([hidden, hidden.map((h) => h + 1), hidden.map((h) => h + 2)]);
        hyp = 'A little more capacity makes training succeed reliably.';
        expect = [{ value: values[values.length - 1], metric: 'success_rate', op: '>', threshold: 0 }];
      }
      const e = c.apply(
        [{ op: 'experiment', target: net.id, ref: 'e', label: 'Search: smallest working architecture', variable: { param: 'hidden', values }, seeds: [1, 2, 3, 4, 5, 6], hypothesis: { text: hyp, expect }, placement: { below: net.id } }],
        'experiment: smallest working change',
      );
      if (!e.ok) return;
      const exp = c.ws.objects[e.refs.e];
      const best = smallestWorking(exp.state);
      if (!best || JSON.stringify(best.value) === JSON.stringify(hidden)) {
        c.host.focus([exp.id]);
        return c.host.say(best ? `${net.label} already has the smallest working architecture; it may just need another seed — try "what if seed = ${best.seed}".` : 'None of the variants I tried converged. The experiment table shows what happened.');
      }
      const units = best.value as number[];
      const assumption = units.length === 1 ? `add a hidden layer of ${units[0]} units` : `hidden layers ${JSON.stringify(units)}`;
      const views = plotsOf(c.ws, net.id).filter((p) => p.params.mode === 'decision_boundary').map((p) => p.id);
      const ops: Operation[] = [
        { op: 'branch', ids: [net.id, ...views], assumption, label: `${units.length === 1 ? `Hidden layer (${units[0]})` : describeArchitecture([2, ...units, 1])}`, changes: [{ id: net.id, param: 'hidden', value: units }, { id: net.id, param: 'seed', value: best.seed }], execute: true, ref: 'v' },
      ];
      const claims = Object.values(c.ws.objects).filter((o) => o.kind === 'claim' && o.state.status === 'unverified' && (o.state.about as string[]).includes(net.id));
      for (const cl of claims) ops.push({ op: 'verify_claim', claim: cl.id, evidence: exp.id });
      const b = c.apply(ops, 'branch: smallest working change');
      if (!b.ok) return;
      const v = c.ws.objects[b.refs.v];
      const m = networkMetrics(c.ws, v);
      const row = (exp.state.results as any[]).find((r) => JSON.stringify(r.value) === JSON.stringify(units));
      c.host.focus([exp.id, ...b.created]);
      c.host.highlight([v.id, `${v.id}#layer:1`], assumption);
      c.host.say(
        `I searched ${values.map(formatValue).join(', ')} across 6 seeds (experiment table). The smallest change that works is to ${assumption}: it converged for ${Math.round(row.summary.success_rate * 6)}/6 seeds. I branched the network with that change (seed ${best.seed}) and trained it — accuracy ${Math.round((m?.accuracy ?? 0) * 100)}%. ${claims.length ? `The claim is now ${c.ws.objects[claims[0].id].state.status}, with the experiment as evidence.` : ''} Compare the branches when you're ready.`,
      );
    },
  },

  // -------------------------------------------------------------------- why
  {
    match: (t) => /\bwhy\b/.test(t) || /what('s| is) wrong/.test(t),
    run(t, c) {
      const sel = c.sel.map((id) => c.ws.objects[id]);
      const lossGraph = sel.find((o) => o.kind === 'simulation' || (o.kind === 'graph' && o.params.mode === 'loss_curve'));
      if (lossGraph && /flat|plateau|stuck|stop/.test(t)) return explainPlateau(c, lossGraph);
      const net = needNet(c);
      if (!net) return;
      explainNetwork(c, net);
    },
  },

  // ----------------------------------------------------------------- glyph
  {
    match: (t) => /\bglyph\b|abstract|reusable|package (this|it)/.test(t),
    run(_t, c, raw) {
      const ws = c.ws;
      let ids = c.sel.flatMap((id) => (ws.objects[id]?.kind === 'neural_network' ? neighbourhoodOf(ws, id) : [id]));
      if (!ids.length) {
        const n = needNet(c);
        if (!n) return;
        ids = neighbourhoodOf(ws, n.id);
      }
      ids = [...new Set(ids)].filter((id) => ws.objects[id] && !ws.objects[id].parent && !['glyph', 'group', 'comparison', 'experiment', 'claim'].includes(ws.objects[id].kind));
      // a dataset shared with other networks stays outside; the glyph keeps a copy-free link to it
      const name = glyphName(raw) ?? 'Construction';
      const net = ids.map((id) => ws.objects[id]).find((o) => o.kind === 'neural_network');
      const r = c.apply(
        [
          {
            op: 'abstract',
            ids,
            name,
            ref: 'g',
            ...(net ? { output: net.id, expose: [{ id: net.id, param: 'hidden', name: 'hidden units' }, { id: net.id, param: 'activation' }, { id: net.id, param: 'seed' }] } : {}),
            description: net ? `${name}: ${describeArchitecture(layersOf(net))} ${net.params.activation} network with its data and decision boundary.` : undefined,
          },
        ],
        `abstract into glyph ${name}`,
      );
      if (!r.ok) return;
      c.host.focus([r.refs.g]);
      c.host.say(`${name} is now a glyph: ${ids.length} objects folded into one, with hidden units, activation and seed exposed. Expand it to see the construction, zoom in to peek inside, or drag a fresh copy from the glyph library.`);
    },
  },

  // --------------------------------------------------------------- compare
  {
    match: (t) => /\bcompare\b|\bversus\b|\bvs\.?\b|difference/.test(t),
    run(_t, c) {
      let [a, b] = c.sel.filter((id) => !['comparison', 'text'].includes(c.ws.objects[id].kind));
      if (!b) {
        const n = a ? netFor(c.ws, a) : c.net();
        if (!n) return c.host.say('Select two things to compare.');
        const partner = relationsFrom(c.ws, n.id, 'branched_from')[0]?.to ?? relationsTo(c.ws, n.id, 'branched_from')[0]?.from;
        if (!partner) return c.host.say(`Select a second object to compare with ${n.label}.`);
        [a, b] = relationsFrom(c.ws, n.id, 'branched_from').length ? [partner, n.id] : [n.id, partner];
      }
      const r = c.apply([{ op: 'compare', a, b, ref: 'cmp' }], 'compare');
      if (r.ok) {
        c.host.focus([r.refs.cmp]);
        c.host.say(`Comparison is live: change either side and it updates.`);
      }
    },
  },

  // ------------------------------------------------------------- experiment
  {
    match: (t) => /experiment|\btest (it|this|the claim)|verify/.test(t),
    run(_t, c) {
      const claim = c.sel.map((id) => c.ws.objects[id]).find((o) => o.kind === 'claim');
      const net = needNet(c);
      if (!net) return;
      const hidden = net.params.hidden as number[];
      c.host.status('running experiment…');
      let op: Operation;
      if (hidden.length === 0) {
        op = { op: 'experiment', target: net.id, ref: 'e', variable: { param: 'hidden', values: [[], [2]] }, seeds: [1, 2, 3, 4, 5, 6], hypothesis: { text: claim ? claim.state.text : 'Without a hidden layer, no seed solves this data; with one, some do.', expect: [{ value: [], metric: 'success_rate', op: '==', threshold: 0 }, { value: [2], metric: 'success_rate', op: '>', threshold: 0 }] } };
      } else {
        op = { op: 'experiment', target: net.id, ref: 'e', label: 'Experiment: which activation?', variable: { param: 'activation', values: ['tanh', 'sigmoid', 'relu'] }, seeds: [1, 2, 3, 4, 5, 6], hypothesis: { text: 'With this architecture, smooth activations (tanh, sigmoid) converge more reliably than ReLU.', expect: [{ value: 'tanh', metric: 'success_rate', op: '>=', threshold: 0.5 }, { value: 'relu', metric: 'success_rate', op: '<', threshold: 0.5 }] } };
      }
      const ops: Operation[] = [op];
      if (claim && claim.state.status === 'unverified') ops.push({ op: 'verify_claim', claim: claim.id, evidence: '$e' });
      const r = c.apply(ops, 'experiment');
      if (!r.ok) return;
      const e = c.ws.objects[r.refs.e];
      c.host.focus([e.id]);
      c.host.say(`${e.state.conclusion}${claim ? ` The claim is now ${c.ws.objects[claim.id].state.status}.` : ''} Every run is seeded — press reproduce to check it.`);
    },
  },

  // ---------------------------------------------------------------- what if
  {
    match: (t) => /what if|\bbranch\b|\bfork\b|alternative/.test(t),
    run(t, c) {
      const net = needNet(c);
      if (!net) return;
      const change = parseChange(t, net);
      if (!change) return c.host.say('Tell me what to change in the branch, e.g. "what if we used relu" or "what if there were 3 hidden units".');
      const views = plotsOf(c.ws, net.id).filter((p) => p.params.mode === 'decision_boundary').map((p) => p.id);
      const r = c.apply([{ op: 'branch', ids: [net.id, ...views], assumption: change.assumption, changes: [{ id: net.id, ...change.change }], execute: !!net.state.trainedBy, ref: 'v' }], `branch: ${change.assumption}`);
      if (!r.ok) return;
      c.host.focus(r.created);
      const v = c.ws.objects[r.refs.v];
      const m = networkMetrics(c.ws, v);
      c.host.say(`Branched: ${change.assumption}.${net.state.trainedBy && m ? ` Trained — accuracy ${Math.round(m.accuracy * 100)}%.` : ''} The original is untouched.`);
    },
  },

  // ------------------------------------------------------------ architecture
  {
    match: (t) => /\b(add|insert|another|one more)\b.*\blayer\b/.test(t),
    run(t, c) {
      const net = needNet(c);
      if (!net) return;
      const units = Number(t.match(/(\d+)\s*(units?|neurons?|nodes?)/)?.[1] ?? 2);
      const r = c.apply([{ op: 'invoke', id: net.id, action: 'add_layer', args: { units } }], 'add hidden layer');
      if (r.ok) {
        c.host.highlight([net.id, ...plotsOf(c.ws, net.id).map((p) => p.id)]);
        c.host.say(`Added a hidden layer of ${units}. ${net.label} is now ${describeArchitecture(layersOf(c.ws.objects[net.id]))}, freshly initialised — the boundary already bends. Train it to see what it learns.`);
      }
    },
  },
  {
    match: (t) => /\b(remove|delete|drop)\b.*\blayer\b/.test(t),
    run(_t, c) {
      const net = needNet(c);
      if (!net) return;
      const r = c.apply([{ op: 'invoke', id: net.id, action: 'remove_layer' }], 'remove hidden layer');
      if (r.ok) c.host.say(`${net.label} is now ${describeArchitecture(layersOf(c.ws.objects[net.id]))}.`);
    },
  },
  {
    match: (t) => ACTS.some((a) => t.includes(a)) && /\b(use|switch|change|make|set|activation)\b/.test(t),
    run(t, c) {
      const net = needNet(c);
      if (!net) return;
      const a = ACTS.find((x) => t.includes(x))!;
      const r = c.apply([{ op: 'set_parameter', id: net.id, param: 'activation', value: a }], `activation → ${a}`);
      if (r.ok) c.host.say(`Hidden activation is now ${a}.${(net.params.hidden as number[]).length === 0 ? ' (This network has no hidden layer, so the output sigmoid is the only nonlinearity — add a layer to see the difference.)' : ''}`);
    },
  },
  {
    match: (t) => /(learning rate|\blr\b|epochs|seed)\s*(to|=|:)?\s*-?[\d.]+/.test(t),
    run(t, c) {
      const net = needNet(c);
      if (!net) return;
      const m = t.match(/(learning rate|\blr\b|epochs|seed)\s*(?:to|=|:)?\s*(-?[\d.]+)/)!;
      const param = m[1].startsWith('l') ? 'learningRate' : m[1];
      c.apply([{ op: 'set_parameter', id: net.id, param, value: Number(m[2]) }], `${param} → ${m[2]}`);
    },
  },
  {
    match: (t) => /\b(xor|and|or|nand|xnor)\b.*\b(data|dataset|problem|points)\b|\bmake (it|the data) (xor|and|or|nand|xnor)\b/.test(t),
    run(t, c) {
      const net = c.net();
      const ds = c.sel.map((id) => c.ws.objects[id]).find((o) => o.kind === 'dataset') ?? (net ? datasetFor(c.ws, net.id) : undefined);
      if (!ds) return c.host.say('There is no dataset to change.');
      const preset = t.match(/\b(xnor|nand|xor|and|or)\b/)![1];
      const r = c.apply([{ op: 'set_parameter', id: ds.id, param: 'preset', value: preset }], `data → ${preset}`);
      if (r.ok) c.host.say(`The data is now ${preset.toUpperCase()} (${nn.linearlySeparable(points(c.ws.objects[ds.id])) ? 'linearly separable' : 'not linearly separable'}). Every network fed by it updates.`);
    },
  },

  // -------------------------------------------------------------- computing
  {
    match: (t) => /\b(train|fit|learn|run it|execute|retrain)\b/.test(t),
    run(_t, c) {
      const net = needNet(c);
      if (!net) return;
      c.host.status('training…');
      const r = c.apply([{ op: 'execute', id: net.id }], `train ${net.label}`);
      if (r.ok) {
        c.host.focus([net.id, ...r.created]);
        c.host.say(r.notes.join(' '));
      }
    },
  },
  {
    match: (t) => /sensitiv|fragile|robust/.test(t),
    run(_t, c) {
      const net = needNet(c);
      if (!net) return;
      const ds = datasetFor(c.ws, net.id);
      if (!ds) return;
      const s = nn.sensitivities(netParams(net), points(ds))[0];
      const w = s.path.join(':');
      const r = c.apply([{ op: 'plot', source: net.id, mode: 'weight_sweep', weight: w, ref: 'p' }], `sensitivity of w${w}`);
      if (r.ok) {
        c.host.highlight([`${net.id}#edge:${w}`, r.refs.p]);
        c.host.say(`The most sensitive weight is w${w} (Δloss ${s.score.toFixed(2)} for a ±0.5 nudge${s.accuracyFlips ? ', enough to change a prediction' : ''}). The plot sweeps it and shows loss and accuracy as it moves.`);
      }
    },
  },
  {
    match: (t) => /\b(plot|graph|visuali[sz]e|show)\b.*\b(boundary|loss|curve|decision|activation)\b/.test(t),
    run(t, c) {
      const net = needNet(c);
      if (!net) return;
      if (/loss|curve/.test(t)) {
        const sim = relationsTo(c.ws, net.id, 'generated_from').map((r) => c.ws.objects[r.from]).find((o) => o?.kind === 'simulation');
        if (!sim) return c.host.say('Train it first; the loss curve lives on the training run.');
        c.apply([{ op: 'plot', source: sim.id, mode: 'loss_curve' }], 'plot loss');
      } else if (/activation/.test(t)) {
        c.apply([{ op: 'create_object', kind: 'function', params: { fn: net.params.activation }, placement: { below: net.id } }], 'plot activation');
      } else c.apply([{ op: 'plot', source: net.id, mode: 'decision_boundary' }], 'plot boundary');
    },
  },
  {
    match: (t) => /\bzoom|inside|look into|neuron|equation|arithmetic|formula\b/.test(t),
    run(t, c) {
      const net = needNet(c);
      if (!net) return;
      const L = layersOf(net).length - 1;
      const m = t.match(/neuron\s*(\d+)(?:[:.,\s]+(\d+))?/);
      const focus = m ? (m[2] ? `${m[1]}:${Number(m[2]) - 1}` : `1:${Number(m[1]) - 1}`) : `${L}:0`;
      const form = /boundary/.test(t) ? 'boundary' : /arithmetic|number|input/.test(t) ? 'arithmetic' : /whole|network|function/.test(t) ? 'network' : 'neuron';
      const r = c.apply([{ op: 'zoom_into', id: net.id, form, focus }], `zoom into ${net.label}`);
      if (r.ok) c.host.focus(r.created);
    },
  },
  {
    match: (t) => /\b(explain|describe|what is|what's|what does)\b/.test(t),
    run(_t, c) {
      const ids = c.sel.length ? c.sel : c.net() ? [c.net()!.id] : [];
      if (!ids.length) return c.host.say('Select something and ask again.');
      for (const id of ids.slice(0, 3)) {
        const o = c.ws.objects[id];
        c.host.say(`${o.label} — ${kindSpec(o.kind)!.title.toLowerCase()}. ${describe(c.ws, o)}`);
      }
      c.host.highlight(ids);
    },
  },
];

// ------------------------------------------------------------------ explanations

function explainNetwork(c: Ctx, net: TSObject) {
  const ws = c.ws;
  const ds = datasetFor(ws, net.id);
  if (!ds) return c.host.say(`${net.label} has no data connected, so there is nothing for it to get wrong yet.`);
  const pts = points(ds);
  const m = networkMetrics(ws, net)!;
  const hidden = net.params.hidden as number[];
  const separable = nn.linearlySeparable(pts);
  const plot = plotsOf(ws, net.id).find((p) => p.params.mode === 'decision_boundary');
  const ops: Operation[] = [];
  let text: string;
  const correct = `${m.correct}/${m.total}`;

  if (m.accuracy === 1) {
    c.host.highlight([net.id, ...(plot ? [plot.id] : [])]);
    return c.host.say(`It does work: ${correct} points are classified correctly (loss ${m.loss.toFixed(3)}).`);
  }
  if (hidden.length === 0 && !separable) {
    const [w1, w2] = net.state.weights[0][0];
    const b = net.state.biases[0][0];
    text =
      `This network computes ŷ = σ(${w1.toFixed(2)}·x₁ + ${w2.toFixed(2)}·x₂ + ${b.toFixed(2)}). ` +
      `σ is monotonic, so ŷ = ½ exactly where w₁x₁ + w₂x₂ + b = 0 — always one straight line, whatever the weights. ` +
      `XOR needs (0,1) and (1,0) on one side and (0,0), (1,1) on the other: the two diagonals cross, so no line can split them. ` +
      `The best any single neuron can do is 3 of 4; it currently gets ${correct}.` +
      (Math.abs(w1) < 0.05 && Math.abs(w2) < 0.05
        ? ` Training makes this vivid: gradient descent minimises loss, and for XOR the lowest-loss line is no line at all — it shrank every weight to ≈0 and now answers ½ everywhere (loss ln 2 ≈ 0.693).`
        : '');
    const hasBoundaryEq = relationsTo(ws, net.id, 'visualizes').some((r) => ws.objects[r.from]?.kind === 'equation' && ws.objects[r.from].params.form === 'boundary');
    if (!hasBoundaryEq) ops.push({ op: 'zoom_into', id: net.id, form: 'boundary', ref: 'eq', placement: plot ? { below: plot.id } : { below: net.id } });
    ops.push({ op: 'annotate', target: plot ? plot.id : net.id, subtarget: 'boundary', text, label: 'Why it fails' });
  } else if (hidden.length > 0 && net.params.activation === 'linear') {
    text = 'Every hidden unit is linear, and a composition of linear maps is linear: the whole network still draws one straight line. It needs a nonlinear activation (tanh, sigmoid, ReLU).';
    ops.push({ op: 'annotate', target: net.id, text, label: 'Why it fails' });
  } else if (hidden.length > 0 && net.params.activation === 'step') {
    text = 'Step units have zero gradient almost everywhere, so gradient descent cannot move the hidden weights. They can represent XOR — set the weights by hand and see — but they cannot learn it.';
    ops.push({ op: 'annotate', target: net.id, text, label: 'Why it fails' });
  } else if (hidden.length > 0) {
    text = `This architecture can represent the data, but training from seed ${net.params.seed} landed in a poor solution (${correct} correct, loss ${m.loss.toFixed(2)}). With so few units some initialisations get stuck — try another seed, a smaller learning rate, or one more unit.`;
    if (!net.state.trainedBy) text = `It hasn't been trained yet: these are random initial weights (${correct} correct). Train it.`;
    ops.push({ op: 'annotate', target: net.id, text, label: 'Why it fails' });
  } else {
    text = `The data is linearly separable, so a single neuron can solve it; ${net.state.trainedBy ? 'training needs more epochs or a larger learning rate.' : 'it just hasn\'t been trained yet.'}`;
    ops.push({ op: 'annotate', target: net.id, text, label: 'Why it fails' });
  }
  const r = c.apply(ops, 'explain with the workspace');
  if (!r.ok) return;
  const out = net.params.hidden && (net.params.hidden as number[]).length === 0 ? `${net.id}#neuron:1:0` : `${net.id}#layer:1`;
  c.host.highlight([out, ...(plot ? [`${plot.id}#boundary`] : []), ds.id, ...r.created]);
  c.host.focus([net.id, ...r.created]);
  c.host.say(hidden.length === 0 && !separable ? 'The output neuron can only draw a straight line — highlighted, with the line\'s equation derived from its current weights. No line separates XOR.' : text);
}

function explainPlateau(c: Ctx, o: TSObject) {
  const sim = o.kind === 'simulation' ? o : sourceOf(c.ws, o.id);
  if (!sim || sim.kind !== 'simulation') return c.host.say('Select the training run to ask about its curve.');
  const r = sim.state.result;
  const flat = r.convergedAt === null;
  const text = flat
    ? `The loss flattens at ${r.finalLoss.toFixed(3)} because the gradient has shrunk to ${r.finalGradNorm.toFixed(4)}: the weights sit in a region where no small step improves the fit. For a single neuron on XOR this is the best line available, not a bug in training.`
    : `The loss flattens after epoch ~${r.convergedAt}: all points are classified correctly and further steps only sharpen the sigmoid's confidence, with diminishing returns.`;
  const a = c.apply([{ op: 'annotate', target: sim.id, text, label: 'Why it flattens' }], 'explain plateau');
  if (a.ok) {
    c.host.highlight([sim.id, ...a.created]);
    c.host.say(text);
  }
}

function describe(ws: Workspace, o: TSObject): string {
  switch (o.kind) {
    case 'neural_network': {
      const m = networkMetrics(ws, o);
      return `${describeArchitecture(layersOf(o))}, ${o.params.activation} hidden units, sigmoid output${m ? `; currently ${m.correct}/${m.total} correct, loss ${m.loss.toFixed(3)}` : '; no data'}${o.state.trainedBy ? `, trained by ${o.state.trainedBy}` : ', untrained'}.`;
    }
    case 'experiment':
      return o.state.conclusion;
    case 'claim':
      return `"${o.state.text}" — ${o.state.status}${o.state.evidence.length ? ` (evidence: ${o.state.evidence.join(', ')})` : ''}.`;
    case 'glyph':
      return `an abstraction over ${o.state.members.length} objects, exposing ${o.state.exposed.map((e: any) => e.name).join(', ')}.`;
    case 'dataset':
      return `${o.state.points.length} points, ${nn.linearlySeparable(points(o)) ? 'linearly separable' : 'not linearly separable'}.`;
    default:
      return JSON.stringify(kindSpec(o.kind)!.summarize(o, ws)).slice(0, 240);
  }
}

// ------------------------------------------------------------------ parsing helpers

function neighbourhoodOf(ws: Workspace, id: ObjectId): ObjectId[] {
  const ds = datasetFor(ws, id);
  const plots = plotsOf(ws, id).filter((p) => !p.parent).map((p) => p.id);
  // include the dataset only if no other network outside this set depends on it
  const dsShared = ds ? relationsFrom(ws, ds.id, 'feeds_into').some((r) => r.to !== id) : false;
  return [...(ds && !dsShared ? [ds.id] : []), id, ...plots];
}

function glyphName(raw: string): string | undefined {
  const m = raw.match(/(?:into|as|make)\s+(?:a|an|the)?\s*(?:reusable\s+)?(.+?)\s+glyph/i);
  const words = (m?.[1] ?? '').replace(/[^\w\s-]/g, '').split(/[\s-]+/).filter((w) => w && !/^(reusable|this|it|a|an|the)$/i.test(w));
  if (!words.length) return undefined;
  return words.map((w) => (w === w.toUpperCase() ? w : w[0].toUpperCase() + w.slice(1))).join('');
}

function parseChange(t: string, net: TSObject): { assumption: string; change: Record<string, unknown> } | undefined {
  const act = ACTS.find((a) => t.includes(a));
  if (act) return { assumption: `${act} activation`, change: { param: 'activation', value: act } };
  const units = t.match(/(\d+)\s*(hidden )?(units?|neurons?|nodes?)/);
  if (units) return { assumption: `${units[1]} hidden units`, change: { param: 'hidden', value: [Number(units[1])] } };
  if (/no hidden|remove the hidden|without (a )?hidden/.test(t)) return { assumption: 'no hidden layer', change: { param: 'hidden', value: [] } };
  if (/hidden layer|another layer|extra layer/.test(t)) {
    const h = [...(net.params.hidden as number[]), 2];
    return { assumption: 'one more hidden layer', change: { param: 'hidden', value: h } };
  }
  const seed = t.match(/seed\s*(?:=|to|of)?\s*(\d+)/);
  if (seed) return { assumption: `seed ${seed[1]}`, change: { param: 'seed', value: Number(seed[1]) } };
  const lr = t.match(/(?:learning rate|\blr\b)\s*(?:=|to|of)?\s*([\d.]+)/);
  if (lr) return { assumption: `learning rate ${lr[1]}`, change: { param: 'learningRate', value: Number(lr[1]) } };
  return undefined;
}

function dedupe(vs: unknown[]): unknown[] {
  const seen = new Set<string>();
  return vs.filter((v) => {
    const k = JSON.stringify(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
