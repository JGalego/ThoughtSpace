// What every LLM participant shares, regardless of provider: the system prompt, the three
// tools, how tool calls are executed against the kernel, and the opening user message.

import type { AgentHost } from './host';
import { kindSpec, protocolDoc, semanticView, type Operation } from '../kernel';

export const SYSTEM = `You are the AI participant in ThoughtSpace, an AI-native medium for thinking. A human and you share one workspace of persistent, semantic, executable objects (datasets, neural networks, plots, equations, training runs, experiments, claims, comparisons, glyphs). The workspace is the product; your chat replies are secondary.

How you work:
- You have hands, not just a mouth. Respond to requests by changing the workspace with apply_operations: build constructions the human can manipulate, attach explanations to the objects they concern (annotate), point at the relevant structure (highlight, including sub-parts like "net_3#neuron:1:0", "net_3#edge:0:0:1", "plot_2#boundary", "net_3#layer:1"), and derive views (plot, zoom_into).
- Never do arithmetic yourself or invent numbers. Training (execute), experiments, metrics and equations are computed by the kernel's deterministic executor; read results from tool results or inspect.
- Before saying something works (or doesn't), check it with the executor — execute a changed network, or run an experiment — and report what the kernel measured.
- Claims start unverified. To support or refute one, run an experiment with an explicit hypothesis and expectations, then verify_claim with it as evidence.
- When exploring an alternative, branch (keeping the original) rather than overwriting. State the assumption.
- Place objects semantically (beside/below/above/left_of/near an existing id) — never coordinates.
- "this", "these", "here" refer to the current selection, which is listed in the workspace view.
- Batch related operations in one apply_operations call; later operations can refer to objects created earlier in the batch as "$ref" when you set "ref" on the creating operation.
- $ref names stay bound for the rest of this request, so later batches can use them too.
- If a batch is rejected, nothing changed: read the errors, fix the operations and resubmit.
- Do what the request asks, then stop and offer the natural next step. Don't run ahead through a whole investigation the human hasn't asked for — they want to explore the objects themselves.
- Prefer the smallest construction that makes the point (for a new question: the data, one model, one view of it, maybe one equation or claim). Don't pre-build variants, comparisons or experiments; the human will ask. Reuse and extend existing objects rather than duplicating them.
- Write replies as plain sentences; object ids in backticks are fine.
- Keep your final reply short (1–4 sentences): say what you changed and what the human might try next. The objects carry the substance.

${protocolDoc()}`;

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'apply_operations',
    description:
      'Submit a batch of typed operations to the workspace kernel. The batch is validated and applied atomically; on any error nothing changes and the errors are returned. Returns created ids, $ref bindings and computed results (training, experiments).',
    parameters: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          description: 'operations like {"op": "set_parameter", "id": "net_2", "param": "activation", "value": "relu"}',
          items: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] },
        },
        rationale: { type: 'string', description: 'one line: why (recorded in history)' },
      },
      required: ['operations'],
    },
  },
  {
    name: 'inspect',
    description: 'Detailed semantic view of specific objects: parameters, state summary, relations, provenance, current metrics.',
    parameters: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] },
  },
  {
    name: 'highlight',
    description: 'Transiently emphasise objects or sub-parts on the canvas to ground an explanation.',
    parameters: {
      type: 'object',
      properties: { targets: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } },
      required: ['targets'],
    },
  },
];

/** The opening user message: recent interaction, the semantic workspace, the request. */
export function openingMessage(text: string, host: AgentHost, history: { role: 'user' | 'ai'; text: string }[]): string {
  const prior = history
    .slice(-8)
    .map((h) => `${h.role === 'user' ? 'Human' : 'You'}: ${h.text}`)
    .join('\n');
  const view = semanticView(host.kernel.state(), host.selection());
  return `${prior ? `Recent interaction:\n${prior}\n\n` : ''}Workspace:\n${JSON.stringify(view)}\n\nHuman: ${text}`;
}

export const MAX_TURNS = 14;

export type ToolRunner = (name: string, input: unknown) => { content: string; error?: boolean };

/**
 * A tool executor for one agent turn. $ref names bound in one batch stay usable in the
 * batches that follow, so a model can build in steps without copying ids around.
 */
export function toolRunner(host: AgentHost): ToolRunner {
  const refs: Record<string, string> = {};
  return (name, input) => runTool(name, input, host, refs);
}

/** Execute one tool call against the kernel. Results are strings; errors are flagged. */
export function runTool(name: string, input: unknown, host: AgentHost, refs: Record<string, string> = {}): { content: string; error?: boolean } {
  const args = (input ?? {}) as Record<string, any>;
  switch (name) {
    case 'apply_operations': {
      if (!Array.isArray(args.operations)) return { content: 'operations must be an array', error: true };
      // highlight is transient pointing, not a workspace change; models often batch it anyway
      const ops = (args.operations as Operation[]).filter((o) => {
        if (o?.op !== 'highlight') return true;
        const t = o.targets ?? o.ids ?? o.id ?? o.target;
        host.highlight((Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === 'string'), typeof o.note === 'string' ? o.note : undefined);
        return false;
      });
      if (ops.length === 0) return { content: 'ok (highlighted)' };
      const r = host.apply(ops, typeof args.rationale === 'string' ? args.rationale : undefined, refs);
      if (!r.ok) return { content: `Rejected, nothing changed:\n${r.errors.join('\n')}`, error: true };
      Object.assign(refs, r.refs);
      return {
        content: JSON.stringify({ ok: true, created: r.created, refs: r.refs, results: r.notes, workspace: semanticView(host.kernel.state(), host.selection()) }),
      };
    }
    case 'inspect': {
      const ws = host.kernel.state();
      const ids: string[] = Array.isArray(args.ids) ? args.ids : [];
      const out = ids.map((id) => {
        const o = ws.objects[id];
        if (!o) return { id, error: 'no such object' };
        return {
          id,
          kind: o.kind,
          label: o.label,
          ...kindSpec(o.kind)!.summarize(o, ws),
          provenance: { ...o.provenance, history: o.provenance.history.slice(-5) },
          relations: Object.values(ws.relations).filter((r) => r.from === id || r.to === id).map((r) => [r.from, r.type, r.to]),
        };
      });
      return { content: JSON.stringify(out) };
    }
    case 'highlight': {
      const targets: string[] = Array.isArray(args.targets) ? args.targets.filter((t: unknown) => typeof t === 'string') : [];
      host.highlight(targets, typeof args.note === 'string' ? args.note : undefined);
      return { content: 'ok' };
    }
    default:
      return { content: `unknown tool ${name}`, error: true };
  }
}
