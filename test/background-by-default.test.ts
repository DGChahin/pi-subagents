/**
 * background-by-default.test.ts — the `backgroundByDefault` flip, asserted at
 * the tool boundary rather than at the resolver.
 *
 * `documented-defaults.test.ts` pins `resolveAgentInvocationConfig`'s arguments;
 * this pins what the orchestrator actually receives back from a real `Agent`
 * call, which is the part the tool description makes promises about:
 *
 *   - an unqualified spawn hands back an ID and its output is retrieved later,
 *   - `run_in_background: false` is rejected without starting an agent,
 *   - a fan-out sized like the ones the description tells the model to send
 *     runs concurrently instead of queueing behind `maxConcurrent`.
 *
 * That last one is the reason the concurrency default moved 4 → 10: internal
 * foreground agents bypass the pool, but every external top-level dispatch
 * occupies it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { type Hermetic, hermeticDir } from "./helpers/boot-extension.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerMarkdownTransformer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function ctx() {
  return {
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      notify: vi.fn(),
      getToolsExpanded: vi.fn(() => true),
      setToolsExpanded: vi.fn(),
      setWorkingVisible: vi.fn(),
      setHiddenThinkingLabel: vi.fn(),
    },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;

/** Observe the manager's terminal settlement before retrieving stored output. */
async function waitForSettled(agentId: string): Promise<void> {
  const manager = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as {
    getRecord(id: string): AgentRecord | undefined;
  };
  const record = manager.getRecord(agentId);
  expect(record).toBeDefined();
  if (!record?.promise) throw new Error(`agent ${agentId} has no tracked run`);
  await record.promise;
  expect(record.settledRevision).toBe(record.runRevision);
}

const settled = (text: string) =>
  vi.mocked(runAgent).mockResolvedValue({
    responseText: text,
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: false,
  } as any);

function spawn(tools: Map<string, any>, params: Record<string, unknown> = {}) {
  return tools
    .get("Agent")
    .execute(
      "tc",
      { prompt: "go", description: "d", subagent_type: "general-purpose", ...params },
      undefined,
      undefined,
      ctx(),
    );
}

let hermetic: Hermetic | undefined;

beforeEach(() => {
  hermetic = hermeticDir({ settings: { outputTranscript: false } });
  vi.mocked(runAgent).mockReset();
});

afterEach(() => {
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  registerAgents(new Map());
  hermetic?.restore();
  hermetic = undefined;
});

describe("backgroundByDefault", () => {
  it("returns an ID immediately and exposes output through get_subagent_result", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    settled("THE-PAYLOAD");

    const started = await spawn(tools);
    const out = textOf(started);

    expect(out).toContain("Agent ID:");
    expect(out).not.toContain("THE-PAYLOAD");

    await waitForSettled(started.details.agentId);
    const retrieved = textOf(
      await tools
        .get("get_subagent_result")
        .execute("tc-result", { agent_id: started.details.agentId, wait: true }, undefined, undefined, ctx()),
    );
    expect(retrieved).toContain("THE-PAYLOAD");
  });

  it("rejects run_in_background: false without starting an agent", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    settled("THE-PAYLOAD");
    vi.mocked(runAgent).mockClear();

    const out = textOf(await spawn(tools, { run_in_background: false }));

    expect(out).toContain("Foreground Agent execution is disabled");
    expect(out).toContain("get_subagent_result");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("starts a six-way fan-out concurrently instead of queueing the tail", async () => {
    // Six is the shape the Agent tool description tells the model to send.
    // With maxConcurrent at its old 4 this queued two of them.
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    // Never settles — every agent stays occupying its slot for the whole test.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);

    const outs: string[] = [];
    for (let i = 0; i < 6; i++) outs.push(textOf(await spawn(tools)));

    expect(outs).toHaveLength(6);
    for (const out of outs) expect(out).not.toContain("queued");
  });
});
