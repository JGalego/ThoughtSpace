// The surface an AI participant gets: the same kernel the human uses, plus the ability to
// point at things. Both the offline planner and Claude act only through this interface.

import type { Kernel, ObjectId, Operation, OpResult } from '../kernel';

export interface AgentHost {
  kernel: Kernel;
  selection(): ObjectId[];
  /** submit a validated batch as the AI */
  apply(ops: Operation[], summary?: string): OpResult;
  /** transient emphasis on objects or sub-parts: "net_2", "net_2#neuron:1:0", "net_2#edge:0:0:1" */
  highlight(targets: string[], note?: string): void;
  /** bring objects into view */
  focus(ids: ObjectId[]): void;
  /** a short line in the interaction history */
  say(text: string): void;
  /** progress indicator */
  status(text: string | null): void;
}

export interface Agent {
  name: string;
  run(text: string, host: AgentHost, history: { role: 'user' | 'ai'; text: string }[]): Promise<void>;
}
