// Claude as a participant in the workspace. Claude never edits the UI: it reads the
// semantic workspace and submits typed operation batches that the kernel validates.
// Validation errors come back as tool errors so Claude can correct itself.

import Anthropic from '@anthropic-ai/sdk';
import type { Agent } from './host';
import { MAX_TURNS, openingMessage, SYSTEM, TOOL_DEFS, toolRunner } from './shared';

export interface ClaudeConfig {
  /** 'proxy' uses the dev-server proxy (key stays server-side); otherwise a user-supplied key */
  mode: 'proxy' | 'key';
  apiKey?: string;
  model: string;
}

export const DEFAULT_MODEL = 'claude-opus-5';

const TOOLS: Anthropic.Beta.BetaTool[] = TOOL_DEFS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.parameters as Anthropic.Beta.BetaTool['input_schema'],
}));

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
      const runTool = toolRunner(host);
      const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: openingMessage(text, host, history) }];

      for (let turn = 0; turn < MAX_TURNS; turn++) {
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
          const out = runTool(call.name, call.input);
          return { type: 'tool_result', tool_use_id: call.id, content: out.content, ...(out.error ? { is_error: true } : {}) };
        });
        messages.push({ role: 'user', content: results });
      }
      host.say('I stopped after many steps; the workspace shows what I did.');
    },
  };
}

function errorText(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'Claude rejected the API key. Check it in settings (⚙).';
  if (e instanceof Anthropic.RateLimitError) return 'Claude is rate-limited right now; try again in a moment.';
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach Claude (network). The offline planner still works.';
  if (e instanceof Anthropic.APIError) return `Claude API error ${e.status}: ${e.message}`;
  return `Agent error: ${(e as Error).message}`;
}
