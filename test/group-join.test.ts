import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupJoinManager, type AgentRunCompletion } from "../src/group-join.js";
import type { AgentRecord } from "../src/types.js";

function makeCompletion(id: string, overrides: Partial<AgentRecord> = {}): AgentRunCompletion {
  const record: AgentRecord = {
    id,
    type: "general-purpose",
    description: "test",
    status: "completed",
    toolUses: 0,
    startedAt: 0,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    runRevision: 1,
    settledRevision: 1,
    pendingDeliveryRevision: 1,
    ...overrides,
  };
  return { record, revision: record.runRevision };
}

const ids = (runs: readonly AgentRunCompletion[]) => runs.map(({ record }) => record.id);

describe("GroupJoinManager", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("passes an unregistered run through", () => {
    const deliver = vi.fn();
    const manager = new GroupJoinManager(deliver);

    expect(manager.onAgentComplete(makeCompletion("a"))).toBe("pass");
    expect(deliver).not.toHaveBeenCalled();
  });

  it("holds exact revisions and delivers the full group once", () => {
    const deliver = vi.fn();
    const manager = new GroupJoinManager(deliver);
    const a = makeCompletion("a", { result: "A" });
    const b = makeCompletion("b", { result: "B" });
    manager.registerGroup("g", [a, b]);

    expect(manager.onAgentComplete(a)).toBe("held");
    expect(manager.onAgentComplete(b)).toBe("delivered");
    expect(ids(deliver.mock.calls[0][0]).sort()).toEqual(["a", "b"]);
    expect(deliver.mock.calls[0][1]).toBe(false);
    expect(manager.onAgentComplete(a)).toBe("pass");
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("delivers a timed-out partial group and uses the shorter straggler timeout", () => {
    const deliver = vi.fn();
    const manager = new GroupJoinManager(deliver, 30_000);
    const a = makeCompletion("a");
    const b = makeCompletion("b");
    const c = makeCompletion("c");
    manager.registerGroup("g", [a, b, c]);

    manager.onAgentComplete(a);
    vi.advanceTimersByTime(30_000);
    expect(ids(deliver.mock.calls[0][0])).toEqual(["a"]);
    expect(deliver.mock.calls[0][1]).toBe(true);

    manager.onAgentComplete(b);
    vi.advanceTimersByTime(14_999);
    expect(deliver).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(ids(deliver.mock.calls[1][0])).toEqual(["b"]);
    expect(deliver.mock.calls[1][1]).toBe(true);
    expect(manager.isGrouped("c")).toBe(true);
  });

  it("rejects stale revisions and consumes only the registered run", () => {
    const deliver = vi.fn();
    const manager = new GroupJoinManager(deliver);
    const a = makeCompletion("a");
    const b = makeCompletion("b");
    manager.registerGroup("g", [a, b]);

    const stale = { record: a.record, revision: 0 };
    expect(manager.onAgentComplete(stale)).toBe("pass");
    expect(manager.consume("a", 0)).toBe(false);
    expect(manager.consume("a", 1)).toBe(true);

    expect(manager.onAgentComplete(b)).toBe("delivered");
    expect(ids(deliver.mock.calls[0][0])).toEqual(["b"]);
  });

  it("dispose clears held runs and timers", () => {
    const deliver = vi.fn();
    const manager = new GroupJoinManager(deliver, 30_000);
    const a = makeCompletion("a");
    const b = makeCompletion("b");
    manager.registerGroup("g", [a, b]);
    manager.onAgentComplete(a);

    manager.dispose();
    vi.advanceTimersByTime(60_000);

    expect(deliver).not.toHaveBeenCalled();
    expect(manager.isGrouped("a")).toBe(false);
    expect(manager.isGrouped("b")).toBe(false);
  });
});
