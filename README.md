# ThoughtSpace

**An AI-native medium for thinking.** ThoughtSpace is a shared workspace of persistent,
semantic, executable objects. A human and an AI manipulate the *same* objects through the
same typed protocol. You don't ask a question and read an answer. You build a small world,
poke at it, and the AI helps you modify, explain, test and abstract it.

The idea comes from Michael Nielsen's [*Magic Paper*](https://cognitivemedium.com/magic_paper),
and asks what that medium becomes when the computer understands the semantic structure of
what's on the page.

This first prototype is about one domain, small neural networks, and one journey:
*why does XOR need a hidden layer?*

## Run it

```bash
npm install
npm run dev            # http://localhost:5173 — works offline with the deterministic planner
ANTHROPIC_API_KEY=sk-ant-… npm run dev   # Claude participates; the key stays on the dev server
npm test               # kernel, journey and agent-loop tests
```

You can also paste your own API key in the ⚙ menu. It is kept in your browser and sent
straight to the API. The default model is `claude-opus-5` with adaptive thinking. Claude
requests enable the API's server-side refusal fallback (`fallbacks: "default"`), and if an
account rejects that beta, the request is retried once without it.

## The journey

1. On the blank canvas, click **"Let's understand why XOR requires a hidden layer."**
2. The AI builds a construction rather than writing an answer. You get the XOR data, a
   single neuron fed by it, the neuron's decision boundary, its live equation, and an
   **unverified claim**.
3. **Drag an edge** of the network to change its weight, or **drag a neuron** to change
   its bias. The boundary line and the equation follow in real time. **Click a data
   point** to relabel it (turn XOR into AND and watch the same neuron succeed). Hover a
   point to see the network's activations light up.
4. **Train ▸**. Gradient descent gives up: the weights shrink to ≈0 and the network
   answers ½ everywhere (loss ln 2).
5. Select the network and ask **"Why doesn't this one work?"** The AI highlights the
   output neuron and the boundary, derives the boundary's equation from the live weights,
   and pins its explanation to the plot.
6. **"Show me the smallest change that makes it work."** The AI runs a reproducible
   experiment over hidden sizes × 6 seeds. The experiment verifies the claim, and the AI
   creates a **branch**: the network with 2 hidden units, trained, sitting beside the
   original with its assumption recorded.
7. **Compare branches** (the suggestion on the variant) to get a live side-by-side.
8. **"Turn this into a reusable XOR network glyph."** The construction folds into a
   glyph that exposes its hidden units, activation and seed. You can expand it back into
   its graph, zoom in to see inside, or place new copies from ◆ Glyphs.

Along the way you can zoom the canvas out (objects collapse to their essence) and in
(every weight and bias appears). Double-click a neuron to zoom into its equation, then
into its scalar arithmetic. Fork the whole workspace (⑂) and diff branches. Undo and redo
anything (⌘Z / ⇧⌘Z). Open the inspector to see each object's provenance, history, and
exactly what the AI sees.

## Architecture

```
UI (React)  ─────┐
Offline planner ─┼──►  Workspace kernel  ──►  deterministic executor
Claude agent ────┘     validate · compile      (seeded MLP training, experiments,
                       events · branches        decision grids, sensitivity)
                       undo/redo · persist
```

- `src/kernel/`: framework-independent. `types.ts` (object/relation/event model),
  `kinds.ts` (the kind registry that everything else is generated from), `ops.ts` (the
  semantic operation protocol and its validation), `kernel.ts` (event-sourced history,
  branches, undo/redo, diff), `nn.ts` + `experiment.ts` (the deterministic executor),
  `layout.ts` (semantic placement → coordinates), `suggest.ts` (contextual noticers),
  `formulas.ts` (live equations), `view.ts` (the semantic view the AI gets).
- `src/agent/`: two clients of the kernel that share one host interface. `local.ts` is a
  deterministic planner for the canonical vocabulary. `claude.ts` is a tool-use loop
  (`apply_operations`, `inspect`, `highlight`) in which kernel validation errors are
  returned to Claude as tool errors.
- `src/ui/`: renderers are pure projections of semantic state. There is one per kind,
  inside a generic frame.

The full design (domain model, object schema, protocol, events, rendering, execution
boundary, demo, and scope) is in [`docs/DESIGN.md`](docs/DESIGN.md).

## Principles the code enforces

- **The LLM is never the source of truth.** It submits typed operations. The kernel
  validates each batch atomically and rejects coordinates from the AI.
- **No numbers from the model.** Training, metrics, experiment verdicts and equations
  come from the seeded executor. Results are stored in events, so replay never recomputes
  them.
- **Claims don't silently become facts.** A claim's status changes only through
  `verify_claim` with an experiment as evidence.
- **Abstraction preserves construction.** A glyph keeps its members, relations and a
  frozen definition.
- **Branches are relationships, not copies.** A variant carries `branched_from` and its
  assumption. A workspace fork carries its parent and fork point.
