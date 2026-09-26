// Live end-to-end journey against a real model provider. Skipped unless LIVE=1.
//   LIVE=1 OPENAI_API_KEY=… OPENAI_MODEL=gpt-5.5 npx vitest run tests/live
// Every operation batch the model submits goes through the real kernel; the log shows
// what it tried, what the kernel rejected, and what it said.

import { describe, expect, it } from 'vitest';
import { Kernel, datasetFor, networkMetrics, type ObjectId, type TSObject } from '../../src/kernel';
import type { Agent, AgentHost } from '../../src/agent/host';
import { openaiAgent } from '../../src/agent/openai';

// Any OpenAI-compatible server works: LIVE_BASE_URL (+ LIVE_API=chat for Chat Completions).
//   LIVE=1 LIVE_BASE_URL=http://localhost:11434/v1 LIVE_API=chat LIVE_MODEL=qwen3:4b npx vitest run tests/live
const BASE_URL = process.env.LIVE_BASE_URL;
const API_KEY = process.env.LIVE_API_KEY ?? (BASE_URL ? undefined : process.env.OPENAI_API_KEY);
const LIVE = !!process.env.LIVE && (!!API_KEY || !!BASE_URL);
const MODEL = process.env.LIVE_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-5.5';
const API = (process.env.LIVE_API as 'chat' | 'responses' | undefined) ?? (BASE_URL ? 'chat' : 'responses');

function harness(agent: Agent) {
  const kernel = new Kernel();
  let selection: ObjectId[] = [];
  const history: { role: 'user' | 'ai'; text: string }[] = [];
  const stats = { batches: 0, rejected: 0, highlights: 0 };
  const log = (s: string) => console.log(`[${MODEL}] ${s}`);
  const host: AgentHost = {
    kernel,
    selection: () => selection,
    apply: (ops, summary, refs) => {
      const r = kernel.dispatch(ops, 'ai', { summary, refs });
      stats.batches++;
      log(`  ops ${ops.map((o) => o.op).join(', ')} → ${r.ok ? 'ok' : `REJECTED: ${r.errors.join(' | ')}`}`);
      if (!r.ok) stats.rejected++;
      return r;
    },
    highlight: (t) => {
      stats.highlights++;
      log(`  highlight ${t.join(', ')}`);
    },
    focus: () => {},
    say: (t) => {
      history.push({ role: 'ai', text: t });
      log(`  says: ${t}`);
    },
    status: () => {},
  };
  const ask = async (text: string, sel: ObjectId[] = selection) => {
    selection = sel;
    log(`> ${text}  (this = ${sel.join(', ') || 'nothing'})`);
    const before = history.length;
    await agent.run(text, host, history.slice());
    history.splice(before, 0, { role: 'user', text });
  };
  const objs = () => Object.values(kernel.state().objects) as TSObject[];
  return { kernel, ask, objs, stats };
}

describe.skipIf(!LIVE)(`live journey with ${BASE_URL ?? 'OpenAI'} ${MODEL} (${API})`, () => {
  it(
    'builds, explains, fixes, compares and abstracts through the kernel',
    async () => {
      const h = harness(openaiAgent({ mode: 'key', apiKey: API_KEY, model: MODEL, baseURL: BASE_URL, api: API, label: BASE_URL ?? 'OpenAI' }));

      await h.ask("Let's understand why XOR requires a hidden layer.", []);
      const nets = () => h.objs().filter((o) => o.kind === 'neural_network');
      expect(nets().length).toBeGreaterThan(0);
      const net = nets()[0];
      expect(datasetFor(h.kernel.state(), net.id)).toBeTruthy();
      // a view of the model: a plot or an equation
      expect(h.objs().some((o) => o.kind === 'graph' || o.kind === 'equation')).toBe(true);

      const single = nets().find((n) => (n.params.hidden as number[]).length === 0) ?? net;
      await h.ask("Why doesn't this one work?", [single.id]);

      await h.ask('Show me the smallest change that makes it work.', [single.id]);
      const working = nets().filter((n) => {
        const m = networkMetrics(h.kernel.state(), n);
        return (n.params.hidden as number[]).length > 0 && m?.accuracy === 1;
      });
      expect(working.length).toBeGreaterThan(0);
      const variant = working[0];

      await h.ask('Compare the two branches.', [single.id, variant.id]);
      expect(h.objs().some((o) => o.kind === 'comparison')).toBe(true);

      await h.ask('Turn this into a reusable XOR network glyph.', [variant.id]);
      const glyph = h.objs().find((o) => o.kind === 'glyph');
      expect(glyph).toBeTruthy();
      expect(Object.keys(h.kernel.state().glyphs).length).toBe(1);

      console.log(`[${MODEL}] batches ${h.stats.batches}, rejected ${h.stats.rejected}, highlights ${h.stats.highlights}, objects ${h.objs().length}`);
    },
    Number(process.env.LIVE_TIMEOUT_MIN ?? 15) * 60 * 1000,
  );
});
