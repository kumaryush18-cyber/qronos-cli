// One slot pool for the whole process.
//
// Why it is a module and not a field: a workflow can run in the background while
// the chat is asking for subagents, and two independent limits would quietly
// double the load on the model endpoint. Claude Code keeps one concurrency limit
// for exactly this reason. Everything that spawns a subagent asks here first.
import { DEFAULT_CONCURRENCY } from "./workflow-types";

export interface SlotPool {
  acquire(): Promise<void>;
  release(): void;
  readonly active: number;
  readonly limit: number;
}

export function createSlotPool(limit: number): SlotPool {
  const safeLimit = Math.max(1, Math.floor(limit));
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    async acquire(): Promise<void> {
      if (active < safeLimit) {
        active += 1;
        return;
      }
      await new Promise<void>((resolve) => waiting.push(resolve));
      active += 1;
    },
    release(): void {
      active = Math.max(0, active - 1);
      const next = waiting.shift();
      if (next) next();
    },
    get active(): number {
      return active;
    },
    get limit(): number {
      return safeLimit;
    },
  };
}

let shared: SlotPool | undefined;

/** The process-wide pool. Tests call `resetSharedSlotPool()` between cases. */
export function sharedSlotPool(limit?: number): SlotPool {
  if (!shared) {
    shared = createSlotPool(limit ?? sharedLimitFromEnv());
  }
  return shared;
}

export function sharedLimitFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number.parseInt(env.QRONOS_WORKFLOW_CONCURRENCY ?? "", 10);
  if (!Number.isFinite(value)) return DEFAULT_CONCURRENCY;
  return Math.min(32, Math.max(1, value));
}

export function resetSharedSlotPool(): void {
  shared = undefined;
}
