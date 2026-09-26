// An OpenAI model as a participant in the workspace. Same contract as the Claude agent:
// it reads the semantic workspace and submits typed operation batches through function
// calls; the kernel validates them and rejections come back as tool results to fix.

import OpenAI from 'openai';
import type { Agent } from './host';
import { MAX_TURNS, openingMessage, SYSTEM, TOOL_DEFS, toolRunner } from './shared';

export interface OpenAIConfig {
  /** 'proxy' uses the dev-server proxy (key stays server-side); otherwise a user-supplied key */
  mode: 'proxy' | 'key';
  apiKey?: string;
  model: string;
}

export const DEFAULT_OPENAI_MODEL = 'gpt-5.5';

const TOOLS: OpenAI.Responses.FunctionTool[] = TOOL_DEFS.map((t) => ({
  type: 'function',
  name: t.name,
  description: t.description,
  parameters: t.parameters,
  strict: false,
}));

/** reasoning models take a reasoning effort; older chat models reject it */
const isReasoning = (model: string) => /^(gpt-5|o\d)/.test(model) && !model.includes('chat');

export function openaiAgent(cfg: OpenAIConfig): Agent {
  const client = new OpenAI({
    apiKey: cfg.mode === 'proxy' ? 'dev-proxy' : cfg.apiKey,
    baseURL: cfg.mode === 'proxy' ? `${location.origin}/api/openai/v1` : undefined,
    dangerouslyAllowBrowser: true,
  });

  return {
    name: `OpenAI (${cfg.model})`,
    async run(text, host, history) {
      const runTool = toolRunner(host);
      // The Responses API keeps the turn's state server-side; each step sends only the
      // new function results and points at the previous response.
      let input: OpenAI.Responses.ResponseInput = [{ role: 'user', content: openingMessage(text, host, history) }];
      let previous: string | undefined;

      for (let turn = 0; turn < MAX_TURNS; turn++) {
        host.status(turn === 0 ? 'thinking…' : 'working…');
        let res: OpenAI.Responses.Response;
        try {
          res = await client.responses.create({
            model: cfg.model,
            instructions: SYSTEM,
            input,
            tools: TOOLS,
            max_output_tokens: 16000,
            ...(previous ? { previous_response_id: previous } : {}),
            ...(isReasoning(cfg.model) ? { reasoning: { effort: 'medium' as const } } : {}),
          });
        } catch (e) {
          host.say(errorText(e));
          return;
        }
        previous = res.id;
        const refusal = res.output
          .flatMap((o) => (o.type === 'message' ? o.content : []))
          .find((c): c is OpenAI.Responses.ResponseOutputRefusal => c.type === 'refusal');
        if (refusal) {
          host.say(`The model declined: ${refusal.refusal}`);
          return;
        }
        const calls = res.output.filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === 'function_call');
        if (calls.length === 0) {
          const said = (res.output_text ?? '').trim();
          if (said) host.say(said);
          if (res.status === 'incomplete') host.say(`(reply was cut off: ${res.incomplete_details?.reason ?? 'incomplete'})`);
          return;
        }
        input = calls.map((call) => {
          let out: { content: string; error?: boolean };
          try {
            out = runTool(call.name, JSON.parse(call.arguments || '{}'));
          } catch {
            out = { content: `Arguments were not valid JSON: ${call.arguments.slice(0, 200)}`, error: true };
          }
          return { type: 'function_call_output' as const, call_id: call.call_id, output: out.error ? `ERROR: ${out.content}` : out.content };
        });
      }
      host.say('I stopped after many steps; the workspace shows what I did.');
    },
  };
}

function errorText(e: unknown): string {
  if (e instanceof OpenAI.AuthenticationError) return 'OpenAI rejected the API key. Check it in settings (⚙).';
  if (e instanceof OpenAI.RateLimitError) return 'OpenAI is rate-limited right now; try again in a moment.';
  if (e instanceof OpenAI.NotFoundError) return `OpenAI does not know that model (${(e as Error).message}). Pick another in settings.`;
  if (e instanceof OpenAI.APIConnectionError) return 'Could not reach OpenAI (network). The offline planner still works.';
  if (e instanceof OpenAI.APIError) return `OpenAI API error ${e.status}: ${e.message}`;
  return `Agent error: ${(e as Error).message}`;
}
