// Claude as a participant in the workspace. Claude never edits the UI: it reads the
// semantic workspace and submits typed operation batches that the kernel validates.
// Validation errors come back as tool errors so Claude can correct itself.

import Anthropic from '@anthropic-ai/sdk';
import type { Agent, AgentHost } from './host';
import { kindSpec, protocolDoc, semanticView, type Operation } from '../kernel';

export interface ClaudeConfig {
  /** 'proxy' uses the dev-server proxy (key stays server-side); otherwise a user-supplied key */
  mode: 'proxy' | 'key';
  apiKey?: string;
  model: string;
}

export const DEFAULT_MODEL = 'claude-opus-5';

const SYSTEM = `You are the AI participant in ThoughtSpace, an AI-native medium for thinking. A human and you share one workspace of persistent, semantic, executable objects (datasets, neural networks, plots, equations, training runs, experiments, claims, comparisons, glyphs). The workspace is the product; your chat replies are secondary.

How you work:
- You have hands, not just a mouth. Respond to requests by changing the workspace with apply_operations: build constructions the human can manipulate, attach explanations to the objects they concern (annotate), point at the relevant structure (highlight, including sub-parts like "net_3#neuron:1:0", "net_3#edge:0:0:1", "plot_2#boundary", "net_3#layer:1"), and derive views (plot, zoom_into).
- Never do arithmetic yourself or invent numbers. Training (execute), experiments, metrics and equations are computed by the kernel's deterministic executor; read results from tool results or inspect.
- Claims start unverified. To support or refute one, run an experiment with an explicit hypothesis and expectations, then verify_claim with it as evidence.
- When exploring an alternative, branch (keeping the original) rather than overwriting. State the assumption.
- Place objects semantically (beside/below/above/left_of/near an existing id) — never coordinates.
- "this", "these", "here" refer to the current selection, which is listed in the workspace view.
- Batch related operations in one apply_operations call; later operations can refer to objects created earlier in the batch as "$ref" when you set "ref" on the creating operation.
- Keep your final reply short (1–4 sentences): say what you changed and what the human might try next. The objects carry the substance.

${protocolDoc()}`;

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'apply_operations',
    description:
      'Submit a batch of typed operations to the workspace kernel. The batch is validated and applied atomically; on any error nothing changes and the errors are returned. Returns created ids, $ref bindings and computed results (training, experiments).',
    input_schema: {
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
    input_schema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' } } },
      required: ['ids'],
    },
  },
  {
    name: 'highlight',
    description: 'Transiently emphasise objects or sub-parts on the canvas to ground an explanation.',
    input_schema: {
      type: 'object',
      properties: { targets: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } },
      required: ['targets'],
    },
  },
];

export function claudeAgent(cfg: ClaudeConfig): Agent {
  const client = new Anthropic({
    apiKey: cfg.mode === 'proxy' ? 'dev-proxy' : cfg.apiKey,
    baseURL: cfg.mode === 'proxy' ? `${location.origin}/api/anthropic` : undefined,
    dangerouslyAllowBrowser: true,
  });
  let useFallbacks = true;

  async function create(params: Record<string, unknown>): Promise<Anthropic.Beta.BetaMessage> {
    try {
      return (await client.beta.messages.create({
        ...(params as any),
        ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
      })) as Anthropic.Beta.BetaMessage;
    } catch (e) {
      // Some accounts/proxies reject the fallback beta; retry once without it.
      if (useFallbacks && e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message)) {
        useFallbacks = false;
        return create(params);
      }
      throw e;
    }
  }

  return {
    name: `Claude (${cfg.model})`,
    async run(text, host, history) {
      const prior = history
        .slice(-8)
        .map((h) => `${h.role === 'user' ? 'Human' : 'You'}: ${h.text}`)
        .join('\n');
      const view = semanticView(host.kernel.state(), host.selection());
      const messages: Anthropic.Beta.BetaMessageParam[] = [
        {
          role: 'user',
          content: `${prior ? `Recent interaction:\n${prior}\n\n` : ''}Workspace:\n${JSON.stringify(view)}\n\nHuman: ${text}`,
        },
      ];

      for (let turn = 0; turn < 14; turn++) {
        host.status(turn === 0 ? 'thinking…' : 'working…');
        let res: Anthropic.Beta.BetaMessage;
        try {
          res = await create({
            model: cfg.model,
            max_tokens: 16000,
            thinking: { type: 'adaptive' },
            system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
            tools: TOOLS,
            messages,
          });
        } catch (e) {
          host.say(errorText(e));
          return;
        }

        if (res.stop_reason === 'refusal') {
          host.say('Claude declined this request.');
          return;
        }
        const said = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
        const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
        if (res.stop_reason !== 'tool_use' || calls.length === 0) {
          if (res.stop_reason === 'pause_turn') {
            messages.push({ role: 'assistant', content: res.content as any });
            continue;
          }
          if (said) host.say(said);
          if (res.stop_reason === 'max_tokens') host.say('(reply was cut off)');
          return;
        }
        messages.push({ role: 'assistant', content: res.content as any });
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = calls.map((call) => {
          const out = runTool(call.name, call.input, host);
          return { type: 'tool_result', tool_use_id: call.id, content: out.content, ...(out.error ? { is_error: true } : {}) };
        });
        messages.push({ role: 'user', content: results });
      }
      host.say('I stopped after many steps; the workspace shows what I did.');
    },
  };
}

function runTool(name: string, input: unknown, host: AgentHost): { content: string; error?: boolean } {
  const args = (input ?? {}) as Record<string, any>;
  switch (name) {
    case 'apply_operations': {
      if (!Array.isArray(args.operations)) return { content: 'operations must be an array', error: true };
      const r = host.apply(args.operations as Operation[], typeof args.rationale === 'string' ? args.rationale : undefined);
      if (!r.ok) return { content: `Rejected, nothing changed:\n${r.errors.join('\n')}`, error: true };
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

function errorText(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'Claude rejected the API key. Check it in settings (⚙).';
  if (e instanceof Anthropic.RateLimitError) return 'Claude is rate-limited right now; try again in a moment.';
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach Claude (network). The offline planner still works.';
  if (e instanceof Anthropic.APIError) return `Claude API error ${e.status}: ${e.message}`;
  return `Agent error: ${(e as Error).message}`;
}
