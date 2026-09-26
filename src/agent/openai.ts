// OpenAI models — and any OpenAI-compatible server (Groq, Ollama, OpenRouter, Together,
// LM Studio, vLLM, …) — as participants in the workspace. Same contract as the Claude
// agent: read the semantic workspace, submit typed operation batches through function
// calls; the kernel validates them and rejections come back as tool results to fix.

import OpenAI from 'openai';
import type { Agent, AgentHost } from './host';
import { MAX_TURNS, openingMessage, SYSTEM, TOOL_DEFS, toolRunner, type ToolRunner } from './shared';

export interface OpenAIConfig {
  /** 'proxy' uses a dev-server proxy (key stays server-side); otherwise a user-supplied key */
  mode: 'proxy' | 'key';
  apiKey?: string;
  model: string;
  /** server root including /v1; defaults to OpenAI */
  baseURL?: string;
  /** dev-server path for proxy mode */
  proxyPath?: string;
  /**
   * 'responses' is OpenAI's current API (needed for tools + reasoning on new models);
   * 'chat' is Chat Completions, the dialect every OpenAI-compatible server speaks.
   */
  api?: 'responses' | 'chat';
  /** shown in the UI and in error messages */
  label?: string;
}

export const DEFAULT_OPENAI_MODEL = 'gpt-5.5';

/** Known OpenAI-compatible servers. Any other base URL works too. */
export const COMPATIBLE_PRESETS: { id: string; name: string; baseURL: string; model: string; needsKey: boolean; note?: string }[] = [
  { id: 'groq', name: 'Groq', baseURL: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', needsKey: true },
  { id: 'ollama', name: 'Ollama (local)', baseURL: 'http://localhost:11434/v1', model: 'qwen3:4b', needsKey: false, note: 'start Ollama with OLLAMA_CONTEXT_LENGTH=16384 (the 4k default truncates the workspace) and, for direct browser access, OLLAMA_ORIGINS=*' },
  { id: 'openrouter', name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', model: 'openai/gpt-oss-120b', needsKey: true },
  { id: 'together', name: 'Together', baseURL: 'https://api.together.xyz/v1', model: 'openai/gpt-oss-120b', needsKey: true },
  { id: 'lmstudio', name: 'LM Studio (local)', baseURL: 'http://localhost:1234/v1', model: 'qwen3-4b', needsKey: false },
  { id: 'vllm', name: 'vLLM (local)', baseURL: 'http://localhost:8000/v1', model: 'Qwen/Qwen3-8B', needsKey: false },
];

const RESPONSE_TOOLS: OpenAI.Responses.FunctionTool[] = TOOL_DEFS.map((t) => ({
  type: 'function',
  name: t.name,
  description: t.description,
  parameters: t.parameters,
  strict: false,
}));

const CHAT_TOOLS: OpenAI.Chat.ChatCompletionTool[] = TOOL_DEFS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

/** OpenAI reasoning models take a reasoning effort; older chat models reject it */
const isReasoning = (model: string) => /^(gpt-5|o\d)/.test(model) && !model.includes('chat');

/** Some open models think out loud in the content channel. */
const stripThinking = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

export function openaiAgent(cfg: OpenAIConfig): Agent {
  const label = cfg.label ?? 'OpenAI';
  const client = new OpenAI({
    apiKey: cfg.mode === 'proxy' ? 'dev-proxy' : cfg.apiKey || 'none',
    baseURL: cfg.mode === 'proxy' ? `${location.origin}${cfg.proxyPath ?? '/api/openai'}/v1` : cfg.baseURL,
    dangerouslyAllowBrowser: true,
  });
  const api = cfg.api ?? 'responses';

  return {
    name: `${label} (${cfg.model})`,
    async run(text, host, history) {
      const runTool = toolRunner(host);
      try {
        if (api === 'chat') await chatLoop(client, cfg.model, text, host, history, runTool);
        else await responsesLoop(client, cfg.model, text, host, history, runTool);
      } catch (e) {
        host.say(errorText(e, label));
      }
    },
  };
}

function parseArgs(raw: unknown): unknown {
  if (raw && typeof raw === 'object') return raw; // some servers send objects, not strings
  return JSON.parse(String(raw || '{}'));
}

function execute(runTool: ToolRunner, name: string, raw: unknown): string {
  let out: { content: string; error?: boolean };
  try {
    out = runTool(name, parseArgs(raw));
  } catch {
    out = { content: `Arguments were not valid JSON: ${String(raw).slice(0, 200)}`, error: true };
  }
  return out.error ? `ERROR: ${out.content}` : out.content;
}

/** Responses API: turn state lives server-side; each step sends only the new tool results. */
async function responsesLoop(client: OpenAI, model: string, text: string, host: AgentHost, history: { role: 'user' | 'ai'; text: string }[], runTool: ToolRunner) {
  let input: OpenAI.Responses.ResponseInput = [{ role: 'user', content: openingMessage(text, host, history) }];
  let previous: string | undefined;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    host.status(turn === 0 ? 'thinking…' : 'working…');
    const res = await client.responses.create({
      model,
      instructions: SYSTEM,
      input,
      tools: RESPONSE_TOOLS,
      max_output_tokens: 16000,
      ...(previous ? { previous_response_id: previous } : {}),
      ...(isReasoning(model) ? { reasoning: { effort: 'medium' as const } } : {}),
    });
    previous = res.id;
    const refusal = res.output
      .flatMap((o) => (o.type === 'message' ? o.content : []))
      .find((c): c is OpenAI.Responses.ResponseOutputRefusal => c.type === 'refusal');
    if (refusal) return host.say(`The model declined: ${refusal.refusal}`);
    const calls = res.output.filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === 'function_call');
    if (calls.length === 0) {
      const said = stripThinking(res.output_text ?? '');
      if (said) host.say(said);
      if (res.status === 'incomplete') host.say(`(reply was cut off: ${res.incomplete_details?.reason ?? 'incomplete'})`);
      return;
    }
    input = calls.map((call) => ({ type: 'function_call_output' as const, call_id: call.call_id, output: execute(runTool, call.name, call.arguments) }));
  }
  host.say('I stopped after many steps; the workspace shows what I did.');
}

/** Chat Completions: the conversation is resent each step; works with every compatible server. */
async function chatLoop(client: OpenAI, model: string, text: string, host: AgentHost, history: { role: 'user' | 'ai'; text: string }[], runTool: ToolRunner) {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: openingMessage(text, host, history) },
  ];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    host.status(turn === 0 ? 'thinking…' : 'working…');
    const res = await chatCreate(client, { model, messages, tools: CHAT_TOOLS });
    const choice = res.choices?.[0];
    const msg = choice?.message;
    if (!msg) return host.say('The model returned no message.');
    if (msg.refusal) return host.say(`The model declined: ${msg.refusal}`);
    const calls = (msg.tool_calls ?? []).filter((c): c is OpenAI.Chat.ChatCompletionMessageFunctionToolCall => c.type === 'function');
    if (calls.length === 0) {
      const said = stripThinking(msg.content ?? '');
      if (said) host.say(said);
      if (choice.finish_reason === 'length') host.say('(reply was cut off)');
      return;
    }
    messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls });
    for (const call of calls) messages.push({ role: 'tool', tool_call_id: call.id, content: execute(runTool, call.function.name, call.function.arguments) });
  }
  host.say('I stopped after many steps; the workspace shows what I did.');
}

/**
 * Output-length parameter differs by server: new OpenAI models require
 * max_completion_tokens, some compatible servers only know max_tokens. Try the modern
 * one, fall back once, and remember what worked.
 */
const tokenParam = new WeakMap<OpenAI, 'max_completion_tokens' | 'max_tokens'>();
async function chatCreate(client: OpenAI, body: Omit<OpenAI.Chat.ChatCompletionCreateParamsNonStreaming, 'stream'>): Promise<OpenAI.Chat.ChatCompletion> {
  const param = tokenParam.get(client) ?? 'max_completion_tokens';
  // streamed, then assembled: slow local servers (a CPU thinking model can take minutes)
  // time out non-streaming requests, and streaming keeps the connection alive
  const run = (p: string) => client.chat.completions.stream({ ...body, [p]: 8000, stream: true } as OpenAI.Chat.ChatCompletionCreateParamsStreaming).finalChatCompletion();
  try {
    return await run(param);
  } catch (e) {
    const other = param === 'max_completion_tokens' ? 'max_tokens' : 'max_completion_tokens';
    if (e instanceof OpenAI.BadRequestError && /max_(completion_)?tokens/.test(e.message) && !tokenParam.has(client)) {
      tokenParam.set(client, other);
      return run(other);
    }
    throw e;
  } finally {
    if (!tokenParam.has(client)) tokenParam.set(client, param);
  }
}

function errorText(e: unknown, label: string): string {
  if (e instanceof OpenAI.AuthenticationError) return `${label} rejected the API key. Check it in settings (⚙).`;
  if (e instanceof OpenAI.RateLimitError) return `${label} is rate-limited right now; try again in a moment.`;
  if (e instanceof OpenAI.NotFoundError) return `${label} does not know that model or endpoint (${(e as Error).message}). Check settings.`;
  if (e instanceof OpenAI.APIConnectionError)
    return `Could not reach ${label}. If it's a local server, is it running — and does it allow browser requests (CORS)? The dev-server proxy avoids CORS. The offline planner still works.`;
  if (e instanceof OpenAI.APIError) return `${label} API error ${e.status}: ${e.message}`;
  return `Agent error: ${(e as Error).message}`;
}
