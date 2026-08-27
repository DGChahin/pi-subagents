/**
 * usage-reporting.test.ts — proves subagent spend actually reaches the parent
 * session (#193), through the real registered tools.
 *
 * Pi folds `toolResult.usage` into `getSessionStats()`, which is what the
 * footer, the statusline and `/cost` read. So the observable contract is not
 * "we tracked a number" but "a supported tool result carries a complete pi
 * `Usage`". Top-level Agent dispatch is background-only in this fork, so these
 * examples retrieve completed work through `get_subagent_result`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { addUsage } from "../src/usage.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

/** Drive one detached run that spends `usage` after Agent has returned its ID. */
function runSpending(usage: { input: number; output: number; cacheWrite: number; cacheRead?: number; cost?: number }) {
  vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, opts: any) => {
    await new Promise((resolve) => setImmediate(resolve));
    opts.onAssistantUsage?.(usage);
    return { responseText: "done", session: { dispose: vi.fn(), messages: [] } as any, aborted: false, steered: false };
  });
}

/** Nothing spent — the agent errored before any message_end fired. */
function runSpendingNothing() {
  vi.mocked(runAgent).mockImplementation(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return { responseText: "done", session: { dispose: vi.fn(), messages: [] } as any, aborted: false, steered: false };
  });
}

const spawn = (tools: Map<string, any>, toolCallId: string | undefined) =>
  tools.get("Agent").execute(
    toolCallId,
    { prompt: "go", description: "spend", subagent_type: "general-purpose" },
    undefined,
    undefined,
    ctx(),
  );

/** Retrieve stored output only after this exact top-level revision settles. */
const retrieve = async (tools: Map<string, any>, started: any, toolCallId = "tc-result") => {
  const agentId = started.details.agentId;
  const manager = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as {
    getRecord(id: string): AgentRecord | undefined;
  };
  const record = manager.getRecord(agentId);
  expect(record).toBeDefined();
  if (!record?.promise) throw new Error(`agent ${agentId} has no tracked run`);
  await record.promise;
  expect(record.settledRevision).toBe(record.runRevision);
  return tools.get("get_subagent_result").execute(
    toolCallId,
    { agent_id: agentId, wait: true },
    undefined,
    undefined,
    ctx(),
  );
};

describe("reporting subagent usage back to the parent session", () => {
  let hermetic: Hermetic;
  let shutdown: (() => Promise<void>) | undefined;

  function boot(settings: Record<string, unknown>) {
    hermetic = hermeticDir({ settings: { outputTranscript: false, ...settings } });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    shutdown = async () => {
      await lifecycle.get("session_shutdown")?.();
    };
    return { pi, tools };
  }

  beforeEach(() => {
    vi.mocked(runAgent).mockReset();
    vi.mocked(resumeAgent).mockReset();
  });

  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    registerAgents(new Map());
    hermetic?.restore();
  });

  it("attaches a complete pi Usage to the retrieved result", async () => {
    const { tools } = boot({ reportUsage: true });
    runSpending({ input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: 0.0123 });

    const started = await spawn(tools, "tc-1");
    expect(started.usage).toBeUndefined();
    const result = await retrieve(tools, started);

    // Every field pi's `addUsageToTotals` touches must exist: it reads
    // `usage.cost.total` with no guard, so a partial object throws inside pi.
    expect(result.usage).toEqual({
      input: 100,
      output: 50,
      // Included, unlike our own display total (#38): pi sums cacheRead across
      // the parent's own messages into this same figure, so withholding it
      // would make a subagent's rows count differently from every other row.
      cacheRead: 900,
      cacheWrite: 10,
      totalTokens: 1060,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 },
    });
  });

  it("reports each message's spend exactly once", async () => {
    const { tools } = boot({ reportUsage: true });
    runSpending({ input: 100, output: 50, cacheWrite: 10, cost: 0.0123 });

    const first = await spawn(tools, "tc-1");
    await retrieve(tools, first, "tc-result-1");

    runSpendingNothing();
    const second = await spawn(tools, "tc-2");
    const secondResult = await retrieve(tools, second, "tc-result-2");

    // A pool that failed to reset would re-report the first run's spend here,
    // and the parent's totals would climb for work that happened once.
    expect(secondResult.usage).toBeUndefined();
  });

  it("carries what a later run spends on the later result", async () => {
    const { tools } = boot({ reportUsage: true });
    runSpending({ input: 100, output: 50, cacheWrite: 10, cost: 0.01 });
    const first = await spawn(tools, "tc-1");
    await retrieve(tools, first, "tc-result-1");

    runSpending({ input: 7, output: 3, cacheWrite: 0, cost: 0.002 });
    const second = await spawn(tools, "tc-2");
    const secondResult = await retrieve(tools, second, "tc-result-2");

    expect(secondResult.usage.totalTokens).toBe(10);
    expect(secondResult.usage.cost.total).toBe(0.002);
  });

  it("attaches nothing when the setting is off", async () => {
    const { tools } = boot({ reportUsage: false });
    runSpending({ input: 100, output: 50, cacheWrite: 10, cost: 0.0123 });

    const started = await spawn(tools, "tc-1");
    const result = await retrieve(tools, started);

    expect(started.content[0].text).toContain("Agent started in background");
    expect(result.content[0].text).toContain("done");
    expect(result.usage).toBeUndefined();
  });

  it("defaults to off", async () => {
    const { tools } = boot({});
    runSpending({ input: 100, output: 50, cacheWrite: 10, cost: 0.0123 });

    const started = await spawn(tools, "tc-1");
    expect((await retrieve(tools, started)).usage).toBeUndefined();
  });

  it("attaches nothing to a call with no tool-call id, and loses none of it", async () => {
    // The `@handle` mention path calls Agent with `undefined` from a discarded
    // conversation clone, so usage attached there would never reach the parent.
    const { tools } = boot({ reportUsage: true });
    runSpending({ input: 100, output: 50, cacheWrite: 10, cost: 0.0123 });

    const cloned = await spawn(tools, undefined);
    expect(cloned.usage).toBeUndefined();

    const real = await retrieve(tools, cloned, "tc-2");
    expect(real.usage.cost.total).toBe(0.0123);
    expect(real.usage.totalTokens).toBe(160);
  });

  it("attaches nothing when a run produced no usage at all", async () => {
    const { tools } = boot({ reportUsage: true });
    runSpendingNothing();

    const started = await spawn(tools, "tc-1");
    expect((await retrieve(tools, started)).usage).toBeUndefined();
  });

  it("reports an unpriced model's tokens with a zero cost rather than dropping them", async () => {
    const { tools } = boot({ reportUsage: true });
    runSpending({ input: 100, output: 50, cacheWrite: 10, cost: 0 });

    const started = await spawn(tools, "tc-1");
    const result = await retrieve(tools, started);

    expect(result.usage.totalTokens).toBe(160);
    expect(result.usage.cost.total).toBe(0);
  });

  it("reports what a background resume spends on its retrieved result", async () => {
    const { tools } = boot({ reportUsage: true });
    runSpending({ input: 100, output: 50, cacheWrite: 0, cost: 0.01 });
    const first = await spawn(tools, "tc-1");
    await retrieve(tools, first, "tc-result-1");

    vi.mocked(resumeAgent).mockImplementation(async (_session: any, _prompt: any, opts: any) => {
      await new Promise((resolve) => setImmediate(resolve));
      opts.onAssistantUsage?.({ input: 7, output: 3, cacheWrite: 0, cost: 0.002 });
      return { text: "resumed" };
    });

    const resumed = await tools.get("Agent").execute(
      "tc-2",
      {
        prompt: "more",
        description: "spend",
        subagent_type: "general-purpose",
        resume: first.details.agentId,
      },
      undefined,
      undefined,
      ctx(),
    );
    const result = await retrieve(tools, resumed, "tc-result-2");

    expect(resumed.usage).toBeUndefined();
    expect(result.usage.cost.total).toBe(0.002);
    expect(result.usage.totalTokens).toBe(10);
  });

  it("counts a nested child's spend once on the top-level retrieved result", async () => {
    // Nested agents are hidden from top-level reporting surfaces, so their spend
    // is double-booked into ancestors for display. The reporting pool instead
    // receives each assistant message once from the manager hook.
    const { pi, tools } = boot({ reportUsage: true });
    let nested = false;

    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, opts: any) => {
      await new Promise((resolve) => setImmediate(resolve));
      opts.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 0, cost: 0.01 });
      if (!nested) {
        nested = true;
        const { manager, parentAgentId } = opts.nestedRuntime;
        const childId = manager.spawn(pi, ctx(), "general-purpose", "sub", {
          description: "nested",
          isBackground: false,
          parentAgentId,
          onAssistantUsage: (u: any) => addUsage(manager.getRecord(parentAgentId).lifetimeUsage, u),
        });
        await manager.getRecord(childId).promise;
      }
      return { responseText: "done", session: { dispose: vi.fn(), messages: [] } as any, aborted: false, steered: false };
    });

    const started = await spawn(tools, "tc-1");
    const result = await retrieve(tools, started);

    expect(nested).toBe(true);
    expect(result.usage.totalTokens).toBe(300);
    expect(result.usage.cost.total).toBeCloseTo(0.02, 10);
  });

  describe("the lifecycle event payload", () => {
    /** The payload `subagents:completed` was emitted with. */
    async function completedPayload(pi: any) {
      for (let i = 0; i < 20; i++) {
        await flush();
        const call = pi.events.emit.mock.calls.find((c: any[]) => c[0] === "subagents:completed");
        if (call) return call[1];
      }
      return undefined;
    }

    it("carries the run's spend as a pi Usage", async () => {
      const { pi, tools } = boot({});
      runSpending({ input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: 0.0123 });

      await spawn(tools, "tc-1");

      expect((await completedPayload(pi)).usage).toEqual({
        input: 100,
        output: 50,
        cacheRead: 900,
        cacheWrite: 10,
        totalTokens: 1060,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 },
      });
    });

    it("carries it regardless of either setting", async () => {
      const { pi, tools } = boot({ reportUsage: false, showCost: false });
      runSpending({ input: 100, output: 50, cacheWrite: 0, cost: 0.01 });

      await spawn(tools, "tc-1");

      expect((await completedPayload(pi)).usage.cost.total).toBe(0.01);
    });

    it("keeps `tokens` as the display total it has always been", async () => {
      const { pi, tools } = boot({});
      runSpending({ input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: 0.0123 });

      await spawn(tools, "tc-1");

      expect((await completedPayload(pi)).tokens).toEqual({ input: 100, output: 50, total: 160 });
    });

    it("omits usage entirely when nothing was spent", async () => {
      const { pi, tools } = boot({});
      runSpendingNothing();

      await spawn(tools, "tc-1");

      const payload = await completedPayload(pi);
      expect(payload.usage).toBeUndefined();
      expect(payload.tokens).toBeUndefined();
    });

    it("reports an unpriced model's tokens with a zero cost", async () => {
      const { pi, tools } = boot({});
      runSpending({ input: 100, output: 50, cacheWrite: 0, cost: 0 });

      await spawn(tools, "tc-1");

      const usage = (await completedPayload(pi)).usage;
      expect(usage.totalTokens).toBe(150);
      expect(usage.cost.total).toBe(0);
    });
  });

  it("reports spend through get_subagent_result", async () => {
    const { tools } = boot({ reportUsage: true });
    runSpending({ input: 100, output: 50, cacheWrite: 10, cost: 0.0123 });

    const started = await spawn(tools, undefined);
    const result = await retrieve(tools, started, "tc-2");

    expect(result.usage.cost.total).toBe(0.0123);
  });
});
