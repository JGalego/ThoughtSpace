// Live: does a real model use the pen when asked to point at something, and read the
// human's ink as a reference? Skipped unless LIVE=1.
import { expect, it } from 'vitest';
import { Kernel, type ObjectId } from '../../src/kernel';
import { localAgent } from '../../src/agent/local';
import { openaiAgent } from '../../src/agent/openai';
import type { AgentHost } from '../../src/agent/host';

const LIVE = !!process.env.LIVE && !!process.env.OPENAI_API_KEY;
const MODEL = process.env.LIVE_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-5.5';

it.skipIf(!LIVE)(`${MODEL} draws on the paper and understands human ink`, async () => {
  const kernel = new Kernel();
  let selection: ObjectId[] = [];
  const said: string[] = [];
  const host: AgentHost = {
    kernel, selection: () => selection, focus: () => {}, status: () => {}, highlight: () => {},
    say: (t) => { said.push(t); console.log(`[${MODEL}] says: ${t}`); },
    apply: (ops, s, refs) => {
      const r = kernel.dispatch(ops, 'ai', { summary: s, refs });
      console.log(`[${MODEL}] ops ${ops.map((o) => (o.op === 'draw' ? `draw(${o.shape} ${o.target})` : o.op)).join(', ')} → ${r.ok ? 'ok' : r.errors.join(' | ')}`);
      return r;
    },
  };
  await localAgent.run("Let's understand why XOR requires a hidden layer.", host, []);
  const objs = () => Object.values(kernel.state().objects);
  const net = objs().find((o) => o.kind === 'neural_network')!;
  const plot = objs().find((o) => o.kind === 'graph')!;
  kernel.dispatch([{ op: 'execute', id: net.id }], 'human');

  const agent = openaiAgent({ mode: 'key', apiKey: process.env.OPENAI_API_KEY, model: MODEL });
  selection = [net.id];
  await agent.run('Circle the object on the canvas that shows why this fails, and put a cross on the claim if it is wrong.', host, []);
  const aiInk = objs().filter((o) => o.kind === 'sketch' && o.provenance.createdBy === 'ai');
  expect(aiInk.length).toBeGreaterThan(0);

  // the human scribbles on the plot and asks about it
  const v = plot.visual;
  kernel.dispatch([{ op: 'draw', over: plot.id, color: 'orange', strokes: [{ points: [[v.x + 40, v.y + 60], [v.x + 120, v.y + 200], [v.x + 200, v.y + 90]] }] }], 'human');
  selection = [];
  await agent.run('What did I just draw on, and what does that object show?', host, []);
  expect(said.at(-1)!.toLowerCase()).toMatch(/boundary|plot/);
}, 10 * 60 * 1000);
