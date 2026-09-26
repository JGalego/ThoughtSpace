# ThoughtSpace — Design of the first prototype

ThoughtSpace is an AI-native medium for thinking. This document is the design for the
smallest coherent version of it: a workspace of persistent, semantic, executable objects
that a human and an AI manipulate through the same typed protocol, built around one
domain — small neural networks — and one canonical journey: *why does XOR need a hidden
layer?*

The design answers eight questions, in order, then lists what was deliberately left out.

---

## 1. Core domain model

```
Workspace (one timeline state)
 ├── objects      Record<ObjectId, TSObject>        the things you think with
 ├── relations    Record<RelationId, Relation>      typed edges between objects
 ├── glyphs       Record<GlyphDefId, GlyphDefinition>   reusable abstractions (library)
 └── (derived)    experiments, claims, variants — these are objects/relations, not side tables

Kernel (owns history)
 ├── branches     Record<BranchId, Branch>          timelines; a branch = parent + fork point + own transactions
 ├── transactions Transaction[] per branch          each = one validated operation batch → events
 └── cursor       per branch                        undo/redo moves it
```

Everything a user can point at is an **object**. Experiments, claims, comparisons,
training runs and glyph instances are objects too, so they can be selected, moved,
annotated, compared, referenced by the AI, and carry provenance like anything else.

A **relation** is a typed, directed edge with its own provenance:

| type            | from → to                     | meaning                                   |
|-----------------|-------------------------------|-------------------------------------------|
| `feeds_into`    | dataset → network             | data flows along the edge (typed ports)   |
| `visualizes`    | graph → network/sim/function  | the graph is a projection of the source   |
| `derived_from`  | object → object               | computed or copied from                   |
| `branched_from` | variant → original            | an explicit alternative, with assumption  |
| `compares_with` | comparison → object           | comparison operand                        |
| `verified_by`   | claim → experiment            | evidence for/against a claim              |
| `annotates`     | note → object                 | commentary attached to an object          |
| `composed_of`   | glyph/group → member          | abstraction keeps its construction        |
| `generated_from`| simulation/experiment → net   | computation that produced it              |
| `parameterizes` | equation → network            | a view of an object's parameters          |
| `instance_of`   | glyph → glyph definition      | reuse                                     |

## 2. Workspace object schema

```ts
interface TSObject {
  id: ObjectId
  kind: ObjectKind          // text | equation | function | graph | neural_network | dataset
                            // | simulation | experiment | comparison | claim | group | glyph
  label: string
  params: Record<string, ParamValue>   // user-facing knobs, validated against the kind's ParamSpec[]
  state: JSON                          // semantic state (weights, points, results, …)
  visual: { x, y, w, h, hidden?, expanded? }   // a projection hint, never the source of truth
  provenance: Provenance
  parent?: ObjectId                    // containment (glyph / group)
}
```

`inputs` / `outputs` (ports), the parameter schema, the default state, the executable
behaviour and the kind-specific *actions* are not stored on the object: they come from the
**kind registry** (`src/kernel/kinds.ts`). Adding a new kind means adding one `KindSpec`
and (optionally) one renderer; the kernel, the protocol, the inspector and the AI tool
description are all generated from the registry, so nothing is hard-coded around a kind.

```ts
interface KindSpec {
  kind, title, description           // description is shown to the AI
  params: ParamSpec[]                // name, type, range/options, default, description
  ports(obj): { inputs: Port[], outputs: Port[] }
  defaultState(params, ctx)
  onParamChange?(obj, name, value)   // e.g. changing hidden layers re-initialises weights
  actions?: Record<string, ActionSpec>   // typed kind-specific verbs: add_layer, set_weight, flip_label…
  summarize(obj, ws)                 // the semantic view the AI receives
}
```

```ts
interface Provenance {
  createdBy: 'human' | 'ai' | 'system'
  createdAt: number
  operation: string        // op that created it (create_object, branch, experiment, abstract…)
  txId: string             // the transaction — links to the event log
  derivedFrom: ObjectId[]
  experiment?: ObjectId
  verifiedBy: ObjectId[]
  assumption?: string      // for branches
  note?: string
  history: { actor, at, op, txId }[]   // every later modification
}
```

## 3. Semantic operation protocol (AI ⇄ kernel)

Every client — the React UI, the offline planner, Claude — talks to the kernel with the
same JSON operations. The model never emits coordinates or DOM edits; it emits intent:

```jsonc
{ "op": "create_object", "kind": "neural_network", "ref": "net",
  "params": { "hidden": [] }, "placement": { "beside": "$data" } }
{ "op": "connect", "from": "$data", "to": "$net", "relation": "feeds_into" }
{ "op": "set_parameter", "id": "net_1", "param": "activation", "value": "relu" }
{ "op": "invoke", "id": "net_1", "action": "add_layer", "args": { "units": 2 } }
{ "op": "execute", "id": "net_1" }                          // deterministic training → simulation object
{ "op": "experiment", "target": "net_1", "variable": { "param": "hidden", "values": [[], [1], [2]] },
  "seeds": [1,2,3,4], "hypothesis": { "text": "…", "expect": [ … ] } }
{ "op": "branch", "ids": ["net_1", "plot_1"], "assumption": "add a hidden layer of 2 units",
  "changes": [ { "id": "net_1", "param": "hidden", "value": [2] } ], "execute": true }
{ "op": "compare", "a": "net_1", "b": "net_2" }
{ "op": "abstract", "ids": [...], "name": "XORNetwork", "expose": [ { "id": "net_2", "param": "hidden" } ] }
{ "op": "annotate", "target": "plot_1", "text": "…" }
{ "op": "claim", "text": "…", "about": ["net_1"] }  →  { "op": "verify_claim", "claim": "…", "evidence": "exp_1" }
```

Full list: `create_object, delete_object, modify_object, set_parameter, invoke, move_object, draw, set_boundary,
resize_object, connect, disconnect, duplicate, group, ungroup, abstract, expand,
instantiate_glyph, execute, plot, zoom_into, experiment, reproduce, branch, compare,
annotate, claim, verify_claim`. (`inspect` and `highlight` are read-only / transient and
live on the agent host, not in the log.)

Rules:

* A **batch** of operations is one transaction: validated and applied atomically, or not
  at all. Later ops may reference objects created earlier in the batch via `$ref`.
* Validation is structural (known op, required fields, types) and semantic (object
  exists, param in range, relation allowed between these port types, claim status can
  only change through `verify_claim` with evidence, AI cannot pass raw coordinates).
* Errors are returned to the caller as data (`{ ok: false, errors: [...] }`); for Claude
  this becomes an `is_error` tool result it can recover from.
* Placement is semantic: `{ beside | below | above | left_of | near: id }` or omitted.
  The layout engine turns that into coordinates. Only direct manipulation (the human's
  mouse) produces raw `{ x, y }`.

## 4. Event model

Operations are intentions; **events are facts**. The kernel compiles each validated
operation into events and appends them as one transaction:

```
ObjectCreated  ObjectModified  ObjectDeleted  RelationAdded  RelationRemoved
ObjectAbstracted  GlyphDefined  ComputationExecuted  ExperimentStarted  ExperimentCompleted
VariantCreated  BranchCompared  ClaimGenerated  ClaimVerified  Annotated
```

Each event carries `actor` (human / ai / system), time, `txId`, and the op that produced
it — so `UserCreatedObject` vs `AgentCreatedObject` is `ObjectCreated` + actor. Events are
fully materialised: computation results (loss curves, weights, experiment tables) are
*in* the event, so replay is pure and never re-runs a computation or reads the clock.

* **Undo/redo** — per-branch cursor over transactions; state is recomputed from cached
  snapshots. Human weight-dragging coalesces into one transaction.
* **Workspace branches** — a branch is `{ parent, forkIndex, transactions }`. Its state is
  the parent's state at the fork point plus its own transactions. The relationship is
  explicit and inspectable, and the kernel can diff any two branches semantically.
* **Object variants** — `branch` inside one workspace copies a sub-graph, applies the
  stated changes, and records `branched_from` + the assumption, so the original and the
  alternative sit side by side and can be compared live.
* **Persistence** — the transaction log is saved to `localStorage`; reload = replay.

## 5. Rendering architecture

```
Kernel state ──► Canvas (pan / zoom / select)
                   ├── RelationLayer (SVG edges between object frames)
                   └── ObjectFrame × N (HTML, absolutely positioned)
                         ├── header: label, provenance mark (✦ AI / ● you), kind
                         ├── body:   renderers[kind](obj, ws, detail)
                         └── suggestions attached to the object
Inspector (params generated from ParamSpec, provenance, relations, event history, AI view)
Command bar (natural language + current selection as "this")
```

* Renderers are **pure projections** of semantic state. Derived quantities — decision
  boundary grid, current accuracy, live equations with substituted weights, comparisons
  — are computed on render by the deterministic executor, so every change is visible
  immediately and nothing drifts.
* **Semantic zoom** has two axes. Canvas zoom picks a detail level (`glance / normal /
  detail`) that each renderer interprets: a network is a chip at glance, a diagram at
  normal, and shows every weight and neuron equation at detail; a collapsed glyph shows
  its internal graph when you zoom into it. Object zoom (`zoom_into`) produces a linked
  object one level down: network → neuron → `σ(w·x + b)` with live values → the scalar
  arithmetic for a specific input.

## 6. Execution boundary

```
       Claude / offline planner  (plans, interprets; never computes)
                 │ typed ops
                 ▼
       Kernel (validate → execute → events)
                 │
                 ▼
       Deterministic executor (src/kernel/nn.ts, experiment.ts)
         seeded PRNG · forward pass · backprop · BCE · full-batch GD
         decision-boundary grids · sensitivity · experiment runner
```

The LLM never produces numbers that become state. Training, measurements, experiment
outcomes, claim verdicts and "smallest working change" searches are computed by the
executor with explicit seeds; results are stored in events and a `reproduce` op re-runs
an experiment and checks the result hash matches. The executor is plain TypeScript with
no framework dependency, so it can move to a worker or a Python sandbox later without
touching the protocol.

## 7. Canonical demo: *why does XOR need a hidden layer?*

1. Blank ThoughtSpace. The user types *"Let's understand why XOR requires a hidden layer."*
2. The agent constructs a world, not an answer: an XOR **dataset** (four clickable points),
   a single-neuron **network** fed by it, its **decision boundary** plot, the neuron's
   **equation** with live weights, and an unverified **claim**: *a single neuron cannot
   represent XOR.*
3. The user drags weights on the network; the boundary line moves in real time. They can
   click dataset points to turn XOR into AND and watch the same neuron succeed.
4. The user trains it (or accepts the suggestion). The simulation shows the loss
   plateauing at 3/4 accuracy.
5. The user adds a hidden layer directly on the network; the plot updates immediately.
6. *"Why doesn't this one work?"* with the single neuron selected: the agent highlights the
   output neuron and the boundary, attaches an annotation, and derives the boundary
   equation `w₁x₁ + w₂x₂ + b = 0` — a straight line — from the live weights.
7. *"Show me the smallest change that makes it work."*: the agent runs a deterministic
   search experiment over hidden sizes × seeds, verifies the claim with it, and creates a
   **variant branch** — the network with 2 hidden units — trained, beside the original,
   with `branched_from` and the assumption recorded.
8. The user compares the branches (a live comparison object: architecture diff, loss,
   accuracy, both boundaries side by side).
9. *"Turn this into a reusable XOR network glyph."* The construction collapses into a
   **glyph** with exposed parameters (hidden units, activation, seed) and a live preview.
   It can be expanded back into its graph, zoomed into, and instantiated again from the
   library.

### Ink

Drawing is part of the medium, as in *Magic Paper*. A human stroke is interpreted by the
renderer, which knows where things are drawn. Where the ink lands on something that
understands it, it compiles to a semantic operation: a dot on data becomes `add_point`, a
line across a single neuron's plot becomes `set_boundary`, and a loop selects. Everything
else becomes a `sketch` object that annotates what it was drawn over and moves with it.
The AI draws only semantic shapes (`draw {shape, target, to?}`), and the kernel computes the
strokes deterministically.

## 8. Smallest feature set that makes the demo compelling

Must-have (built):

* Live, draggable weights and a decision boundary that updates every frame.
* Clickable dataset points (change the problem, not just the model).
* Deterministic training with a visible loss curve and epoch scrubber.
* Agent that builds constructions with typed, validated ops (Claude, plus a deterministic
  offline planner that speaks the same protocol so the demo works without a key).
* Referential "this": the selection is part of every request.
* Highlight + annotate: the agent explains *with* the objects on the canvas.
* Experiments with hypothesis / constants / measures / results and reproducibility.
* Claims that only become "supported" via evidence.
* Variant branches + live comparison; workspace branches + semantic branch diff.
* Glyph abstraction that preserves, re-expands and re-instantiates the construction.
* Provenance inspector on every object; undo/redo; persistence.
* Contextual, dismissible suggestions attached to objects.

Deliberately not built yet: multi-user sync, accounts, arbitrary code sandbox (the
execution boundary is ready for one), document ingestion, plugin system, any object kind
the XOR journey does not exercise.
