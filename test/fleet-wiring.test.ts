/**
 * fleet-wiring.test.ts — end-to-end wiring of the FleetView through the REAL
 * extension (src/index.ts), not the FleetList class in isolation.
 *
 * The unit tests in fleet-list.test.ts drive FleetList with a fake ui/manager.
 * These prove the bits only the extension can: that `tool_execution_start`
 * hands the fleet the live UI (so it captures input), that spawning a background
 * agent actually registers the `belowEditor` widget once the agent has a session,
 * and that `session_shutdown` tears it down. runAgent is mocked (no LLM); the
 * manager, settings load, completion routing, and lifecycle handlers are real.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { type RunResult, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

const BUILTIN_TOOL_NAMES = ["read", "write", "edit", "bash", "grep", "find", "ls"] as const;
const TOOL_ROW_PATCH_STATE_KEY = Symbol.for("pi-subagents:tool-row-suppression");
const ASSISTANT_THINKING_PATCH_STATE_KEY = Symbol.for("pi-subagents:assistant-thinking-suppression");
const originalToolRowRender = ToolExecutionComponent.prototype.render;
const originalAssistantUpdateContent = AssistantMessageComponent.prototype.updateContent;

function restoreToolRowPatchState(): void {
  ToolExecutionComponent.prototype.render = originalToolRowRender;
  delete (globalThis as any)[TOOL_ROW_PATCH_STATE_KEY];
}

function restoreAssistantThinkingPatchState(): void {
  AssistantMessageComponent.prototype.updateContent = originalAssistantUpdateContent;
  delete (globalThis as any)[ASSISTANT_THINKING_PATCH_STATE_KEY];
}

function restorePatchState(): void {
  restoreToolRowPatchState();
  restoreAssistantThinkingPatchState();
}

function makePi() {
  const existingTools = new Map<string, any>([
    ...BUILTIN_TOOL_NAMES.map((name) => [name, { name, owner: "pi" }] as const),
    ["web_search", { name: "web_search", owner: "foreign-extension" }],
  ]);
  const tools = new Map(existingTools);
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerMarkdownTransformer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    getThinkingLevel: vi.fn(() => "high"),
  } as any;
  return { pi, tools, lifecycle, existingTools };
}

/** A UI context with the FleetView and main-card surfaces; setWidget is spied. */
function uiCtx() {
  return {
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    notify: vi.fn(),
    onTerminalInput: vi.fn(() => vi.fn()),
    addAutocompleteProvider: vi.fn(),
    getEditorText: vi.fn(() => ""),
    custom: vi.fn(),
    getToolsExpanded: vi.fn(() => true),
    setToolsExpanded: vi.fn(),
    setWorkingVisible: vi.fn(),
    setHiddenThinkingLabel: vi.fn(),
  };
}

function ctxWith(ui: ReturnType<typeof uiCtx>, mode = "tui") {
  return {
    hasUI: true,
    ui,
    mode,
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
    getSystemPrompt: () => "parent",
    getContextUsage: vi.fn(() => ({ percent: null })),
    isIdle: vi.fn(() => true),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

type Lifecycle = ReturnType<typeof makePi>["lifecycle"];
type TestContext = ReturnType<typeof ctxWith>;

async function startMainPrompt(lifecycle: Lifecycle, ctx: TestContext, prompt: string): Promise<void> {
  await lifecycle.get("session_start")?.({}, ctx);
  await lifecycle.get("before_agent_start")?.({ prompt }, ctx);
  await lifecycle.get("agent_start")?.({}, ctx);
  await lifecycle.get("message_start")?.({ message: { role: "user" } }, ctx);
  await lifecycle.get("message_end")?.({ message: { role: "user" } }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("FleetView wiring (real extension lifecycle)", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    restorePatchState();
    tmpDir = mkdtempSync(join(tmpdir(), "pi-fleet-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-fleet-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    // async join → completion routes straight to sendIndividualNudge (no batch
    // debounce), so fleet.onAgentFinished fires synchronously on the result.
    writeFileSync(
      join(tmpDir, ".pi", "subagents.json"),
      JSON.stringify({ schedulingEnabled: false, defaultJoinMode: "async" }),
    );
    process.chdir(tmpDir);
  });

  afterEach(() => {
    restorePatchState();
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("captures terminal input on tool_execution_start (fleet hooked into the UI)", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui));
    expect(ui.onTerminalInput).toHaveBeenCalled();
  });

  it("registers the belowEditor widget once a spawned agent has a session, then clears it on shutdown", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });

    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const ui = uiCtx();
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui)); // fleet captures THIS ui

    const spawn = await tools
      .get("Agent")
      .execute(
        "tc",
        { prompt: "go", description: "live one", subagent_type: "general-purpose", run_in_background: true },
        undefined,
        undefined,
        ctxWith(uiCtx()),
      );
    expect(textOf(spawn)).toMatch(/Agent ID:/);
    await flush(); // completion → fleet.onAgentFinished → update → widget registers

    const fleetRegs = ui.setWidget.mock.calls.filter((c) => c[0] === "fleet" && typeof c[1] === "function");
    expect(fleetRegs.length, "fleet widget should register with a render factory").toBeGreaterThan(0);

    await lifecycle.get("session_shutdown")?.({}, ctxWith(uiCtx()));
    expect(ui.setWidget).toHaveBeenCalledWith("fleet", undefined); // dispose cleared it
  });
  it("appends and finalizes an inline card for the main context agent", async () => {
    const { pi, tools, lifecycle, existingTools } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    const ctx = ctxWith(ui);
    await lifecycle.get("session_start")?.({}, ctx);
    expect(ui.setWorkingVisible).toHaveBeenCalledWith(false);
    expect(ui.setToolsExpanded).toHaveBeenCalledWith(false);
    const transformer = vi.mocked(pi.registerMarkdownTransformer).mock.calls[0]?.[0];
    expect(transformer?.("thinking", { messageType: "assistant-thinking", isStreaming: false })).toBe("");
    expect(transformer?.("stream", { messageType: "assistant", isStreaming: true })).toBe("");
    expect(transformer?.("answer", { messageType: "assistant", isStreaming: false })).toBe("answer");
    for (const name of ["Agent", "get_subagent_result", "steer_subagent"]) {
      const tool = tools.get(name);
      expect(tool).toMatchObject({ renderShell: "self" });
      expect(tool.renderCall().render(80)).toEqual([]);
      expect(tool.renderResult().render(80)).toEqual([]);
    }
    for (const name of BUILTIN_TOOL_NAMES) {
      expect(tools.get(name)).toBe(existingTools.get(name));
      expect(vi.mocked(pi.registerTool).mock.calls.some(([tool]) => tool.name === name)).toBe(false);
    }
    await lifecycle.get("before_agent_start")?.({ prompt: "inspect" }, ctx);
    await lifecycle.get("agent_start")?.({}, ctx);
    await lifecycle.get("message_start")?.({ message: { role: "user" } }, ctx);
    await lifecycle.get("message_end")?.({ message: { role: "user" } }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vi.mocked(pi.appendEntry).mock.calls[0]?.[0]).toBe("subagents:activity");
    await lifecycle.get("message_start")?.({ message: { role: "assistant" } }, ctx);
    await lifecycle.get("message_update")?.(
      {
        assistantMessageEvent: { type: "thinking_delta", delta: "checking" },
      },
      ctx,
    );
    await lifecycle.get("tool_execution_start")?.({ toolName: "read" }, ctx);
    await lifecycle.get("tool_execution_end")?.({ toolName: "read" }, ctx);
    await lifecycle.get("turn_end")?.({}, ctx);
    await lifecycle.get("message_end")?.(
      {
        message: {
          role: "assistant",
          usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.01 } },
        },
      },
      ctx,
    );
    await lifecycle.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    await lifecycle.get("agent_settled")?.({}, ctx);
    expect(AssistantMessageComponent.prototype.updateContent).not.toBe(originalAssistantUpdateContent);

    const entries = vi.mocked(pi.appendEntry).mock.calls;
    expect(entries[0]?.[0]).toBe("subagents:activity");
    expect(entries[0]?.[1]).toMatchObject({ displayName: "Main", description: "Main context" });
    expect(entries.at(-1)?.[0]).toBe("subagents:activity-final");
    expect(entries.at(-1)?.[1]).toMatchObject({ status: "completed", toolUses: 1, turnCount: 1 });
    expect(ui.setWorkingVisible).toHaveBeenCalledWith(true);
    expect(ui.setHiddenThinkingLabel).toHaveBeenCalledWith("");
    expect(ui.setHiddenThinkingLabel).toHaveBeenLastCalledWith();
    await lifecycle.get("session_shutdown")?.({}, ctx);
    expect(ui.setToolsExpanded).toHaveBeenCalledWith(true);
  });

  it("keeps Main open after an Agent launch until the continuation completes", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    const ctx = ctxWith(ui);
    await startMainPrompt(lifecycle, ctx, "delegate");
    const activityEntries = () =>
      vi
        .mocked(pi.appendEntry)
        .mock.calls.filter(([type, data]) => type === "subagents:activity" && data?.displayName === "Main");
    const finalEntries = () =>
      vi
        .mocked(pi.appendEntry)
        .mock.calls.filter(([type, data]) => type === "subagents:activity-final" && data?.displayName === "Main");
    expect(activityEntries()).toHaveLength(1);

    const spawn = await tools
      .get("Agent")
      .execute(
        "tc-agent",
        { prompt: "go", description: "live one", subagent_type: "general-purpose", run_in_background: true },
        undefined,
        undefined,
        ctx,
      );
    const agentId = spawn.details?.agentId;
    expect(agentId).toEqual(expect.any(String));
    expect(spawn.details).toMatchObject({ agentId });

    await lifecycle.get("tool_execution_end")?.({ toolName: "Agent", isError: false, result: spawn }, ctx);
    await lifecycle.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    await lifecycle.get("agent_settled")?.({}, ctx);
    expect(activityEntries()).toHaveLength(1);
    expect(finalEntries()).toHaveLength(0);
    expect(ui.setHiddenThinkingLabel).toHaveBeenLastCalledWith("");

    await flush();
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "subagents:record",
      expect.objectContaining({ id: agentId, status: "completed" }),
    );
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    await lifecycle.get("before_agent_start")?.({ prompt: "continue" }, ctx);
    await lifecycle.get("agent_start")?.({}, ctx);
    await lifecycle.get("message_start")?.({ message: { role: "assistant" } }, ctx);
    await lifecycle.get("message_update")?.(
      {
        assistantMessageEvent: { type: "text_delta", delta: "continuing" },
      },
      ctx,
    );
    await lifecycle.get("message_end")?.(
      {
        message: {
          role: "assistant",
          usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.01 } },
        },
      },
      ctx,
    );
    await lifecycle.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    await lifecycle.get("agent_settled")?.({}, ctx);
    expect(activityEntries()).toHaveLength(1);
    expect(finalEntries()).toHaveLength(1);
    expect(finalEntries()[0]?.[1]).toMatchObject({ status: "completed" });
    expect(ui.setHiddenThinkingLabel).toHaveBeenCalledWith("");
    expect(ui.setHiddenThinkingLabel).toHaveBeenLastCalledWith();

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  it("restarts Main for a new user message during a pending background continuation", async () => {
    const pendingRun = deferred<RunResult>();
    vi.mocked(runAgent).mockImplementationOnce(() => pendingRun.promise);
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    const ctx = ctxWith(ui);

    try {
      await startMainPrompt(lifecycle, ctx, "delegate");
      const spawn = await tools
        .get("Agent")
        .execute(
          "tc-pending",
          { prompt: "go", description: "pending", subagent_type: "general-purpose", run_in_background: true },
          undefined,
          undefined,
          ctx,
        );
      expect(spawn.details?.agentId).toEqual(expect.any(String));

      await lifecycle.get("tool_execution_end")?.({ toolName: "Agent", isError: false, result: spawn }, ctx);
      await lifecycle.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
      await lifecycle.get("agent_settled")?.({}, ctx);

      const mainActivityEntries = () =>
        vi
          .mocked(pi.appendEntry)
          .mock.calls.filter(([type, data]) => type === "subagents:activity" && data?.displayName === "Main");
      const mainFinalEntries = () =>
        vi
          .mocked(pi.appendEntry)
          .mock.calls.filter(([type, data]) => type === "subagents:activity-final" && data?.displayName === "Main");
      expect(mainActivityEntries()).toHaveLength(1);
      expect(mainFinalEntries()).toHaveLength(0);

      await lifecycle.get("before_agent_start")?.({ prompt: "new prompt" }, ctx);
      await lifecycle.get("agent_start")?.({}, ctx);
      await lifecycle.get("message_start")?.({ message: { role: "user" } }, ctx);
      await lifecycle.get("message_end")?.({ message: { role: "user" } }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mainActivityEntries()).toHaveLength(2);
      expect(mainActivityEntries().map(([, data]) => data)).toEqual([
        expect.objectContaining({ displayName: "Main", description: "Main context", status: "running" }),
        expect.objectContaining({ displayName: "Main", description: "Main context", status: "running" }),
      ]);
      expect(mainFinalEntries()).toHaveLength(1);
      expect(mainFinalEntries()[0]?.[1]).toMatchObject({
        displayName: "Main",
        description: "Main context",
        status: "stopped",
      });
      expect(ui.setWorkingVisible.mock.calls.at(-2)).toEqual([true]);
      expect(ui.setWorkingVisible).toHaveBeenLastCalledWith(false);
      expect(ui.setHiddenThinkingLabel.mock.calls.at(-2)).toEqual([]);
      expect(ui.setHiddenThinkingLabel).toHaveBeenLastCalledWith("");
    } finally {
      pendingRun.resolve({
        responseText: "done",
        session: { dispose: vi.fn() } as any,
        aborted: false,
        steered: false,
      });
      await flush();
      await lifecycle.get("session_shutdown")?.({}, ctx);
    }
  });
  it("finalizes Main for a successful Agent validation result with no spawned record", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    const ctx = ctxWith(ui);
    await startMainPrompt(lifecycle, ctx, "validate");
    const runCallsBefore = vi.mocked(runAgent).mock.calls.length;
    const validation = await tools
      .get("Agent")
      .execute(
        "tc-validation",
        { prompt: "check", description: "validation", subagent_type: "general-purpose", run_in_background: false },
        undefined,
        undefined,
        ctx,
      );
    expect(validation.details).toBeUndefined();
    expect(vi.mocked(runAgent).mock.calls).toHaveLength(runCallsBefore);

    await lifecycle.get("tool_execution_end")?.({ toolName: "Agent", isError: false, result: validation }, ctx);
    await lifecycle.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    await lifecycle.get("agent_settled")?.({}, ctx);

    const activityEntries = vi.mocked(pi.appendEntry).mock.calls.filter(([type]) => type === "subagents:activity");
    const finalEntries = vi.mocked(pi.appendEntry).mock.calls.filter(([type]) => type === "subagents:activity-final");
    expect(activityEntries).toHaveLength(1);
    expect(finalEntries).toHaveLength(1);
    expect(finalEntries[0]?.[1]).toMatchObject({ status: "completed" });
    expect(ui.setHiddenThinkingLabel).toHaveBeenCalledWith("");
    expect(ui.setHiddenThinkingLabel).toHaveBeenLastCalledWith();

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  it("keeps one Main card across partial delivery continuations for two background runs", async () => {
    writeFileSync(
      join(tmpDir, ".pi", "subagents.json"),
      JSON.stringify({ schedulingEnabled: false, defaultJoinMode: "smart" }),
    );
    vi.useFakeTimers();
    const firstRun = deferred<RunResult>();
    const secondRun = deferred<RunResult>();
    vi.mocked(runAgent)
      .mockImplementationOnce(() => firstRun.promise)
      .mockImplementationOnce(() => secondRun.promise);
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    const ctx = ctxWith(ui);

    try {
      await lifecycle.get("session_start")?.({}, ctx);
      await lifecycle.get("before_agent_start")?.({ prompt: "parallel work" }, ctx);
      await lifecycle.get("agent_start")?.({}, ctx);
      await lifecycle.get("message_start")?.({ message: { role: "user" } }, ctx);
      await lifecycle.get("message_end")?.({ message: { role: "user" } }, ctx);
      await vi.advanceTimersByTimeAsync(1);

      const spawnParams = (description: string) => ({
        prompt: `do ${description}`,
        description,
        subagent_type: "general-purpose",
        run_in_background: true,
      });
      const first = await tools.get("Agent").execute("tc-first", spawnParams("first"), undefined, undefined, ctx);
      const second = await tools.get("Agent").execute("tc-second", spawnParams("second"), undefined, undefined, ctx);
      const firstId = first.details?.agentId;
      const secondId = second.details?.agentId;
      expect(firstId).toEqual(expect.any(String));
      expect(secondId).toEqual(expect.any(String));
      expect(secondId).not.toBe(firstId);

      await lifecycle.get("tool_execution_end")?.({ toolName: "Agent", isError: false, result: first }, ctx);
      await lifecycle.get("tool_execution_end")?.({ toolName: "Agent", isError: false, result: second }, ctx);
      await vi.advanceTimersByTimeAsync(100);
      await lifecycle.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
      await lifecycle.get("agent_settled")?.({}, ctx);

      const mainActivityEntries = () =>
        vi
          .mocked(pi.appendEntry)
          .mock.calls.filter(([type, data]) => type === "subagents:activity" && data?.displayName === "Main");
      const mainFinalEntries = () =>
        vi
          .mocked(pi.appendEntry)
          .mock.calls.filter(([type, data]) => type === "subagents:activity-final" && data?.displayName === "Main");
      expect(mainActivityEntries()).toHaveLength(1);
      expect(mainFinalEntries()).toHaveLength(0);
      expect(ui.setHiddenThinkingLabel).toHaveBeenLastCalledWith("");

      firstRun.resolve({
        responseText: "first done",
        session: { dispose: vi.fn() } as any,
        aborted: false,
        steered: false,
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(200);
      expect(pi.appendEntry).toHaveBeenCalledWith(
        "subagents:record",
        expect.objectContaining({ id: firstId, status: "completed" }),
      );
      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
      expect(mainActivityEntries()).toHaveLength(1);
      expect(mainFinalEntries()).toHaveLength(0);
      expect(ui.setHiddenThinkingLabel).toHaveBeenLastCalledWith("");

      await lifecycle.get("before_agent_start")?.({ prompt: "continue after first" }, ctx);
      await lifecycle.get("agent_start")?.({}, ctx);
      await lifecycle.get("message_start")?.({ message: { role: "assistant" } }, ctx);
      await lifecycle.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
      await lifecycle.get("agent_settled")?.({}, ctx);
      expect(mainActivityEntries()).toHaveLength(1);
      expect(mainFinalEntries()).toHaveLength(0);

      secondRun.resolve({
        responseText: "second done",
        session: { dispose: vi.fn() } as any,
        aborted: false,
        steered: false,
      });
      await vi.advanceTimersByTimeAsync(200);
      expect(pi.appendEntry).toHaveBeenCalledWith(
        "subagents:record",
        expect.objectContaining({ id: secondId, status: "completed" }),
      );
      expect(pi.sendMessage).toHaveBeenCalledTimes(2);
      expect(mainActivityEntries()).toHaveLength(1);
      expect(mainFinalEntries()).toHaveLength(0);

      await lifecycle.get("before_agent_start")?.({ prompt: "final continuation" }, ctx);
      await lifecycle.get("agent_start")?.({}, ctx);
      await lifecycle.get("message_start")?.({ message: { role: "assistant" } }, ctx);
      await lifecycle.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
      await lifecycle.get("agent_settled")?.({}, ctx);
      expect(mainActivityEntries()).toHaveLength(1);
      expect(mainFinalEntries()).toHaveLength(1);
      expect(ui.setHiddenThinkingLabel).toHaveBeenCalledWith("");
      expect(ui.setHiddenThinkingLabel).toHaveBeenLastCalledWith();
    } finally {
      firstRun.resolve({
        responseText: "first done",
        session: { dispose: vi.fn() } as any,
        aborted: false,
        steered: false,
      });
      secondRun.resolve({
        responseText: "second done",
        session: { dispose: vi.fn() } as any,
        aborted: false,
        steered: false,
      });
      vi.useRealTimers();
      await lifecycle.get("session_shutdown")?.({}, ctx);
    }
  });

  it("suppresses built-in and foreign TUI rows without replacing their tool definitions", async () => {
    const { pi, tools, lifecycle, existingTools } = makePi();
    subagentsExtension(pi);
    const ctx = ctxWith(uiCtx());

    try {
      await lifecycle.get("session_start")?.({}, ctx);
      expect(ToolExecutionComponent.prototype.render).not.toBe(originalToolRowRender);
      expect(AssistantMessageComponent.prototype.updateContent).not.toBe(originalAssistantUpdateContent);
      for (const name of ["bash", "web_search"]) {
        const row = { toolName: name } as unknown as ToolExecutionComponent;
        expect(ToolExecutionComponent.prototype.render.call(row, 80)).toEqual([]);
        expect(tools.get(name)).toBe(existingTools.get(name));
      }
    } finally {
      await lifecycle.get("session_shutdown")?.({}, ctx);
    }
  });
  it.each([
    "session_before_switch",
    "session_shutdown",
  ] as const)("%s restores the original row renderers", async (event) => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = ctxWith(uiCtx());
    let shutdown = false;

    try {
      await lifecycle.get("session_start")?.({}, ctx);
      expect(ToolExecutionComponent.prototype.render).not.toBe(originalToolRowRender);
      expect(AssistantMessageComponent.prototype.updateContent).not.toBe(originalAssistantUpdateContent);
      await lifecycle.get(event)?.({}, ctx);
      shutdown = event === "session_shutdown";
      expect(ToolExecutionComponent.prototype.render).toBe(originalToolRowRender);
      expect(AssistantMessageComponent.prototype.updateContent).toBe(originalAssistantUpdateContent);
    } finally {
      if (!shutdown) await lifecycle.get("session_shutdown")?.({}, ctx);
    }
  });
  it("does not patch host row renderers for non-TUI sessions", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = ctxWith(uiCtx(), "print");
    try {
      await lifecycle.get("session_start")?.({}, ctx);
      expect(ToolExecutionComponent.prototype.render).toBe(originalToolRowRender);
      expect(AssistantMessageComponent.prototype.updateContent).toBe(originalAssistantUpdateContent);
    } finally {
      await lifecycle.get("session_shutdown")?.({}, ctx);
    }
  });

  it("appends a card for a continuation without a new user message", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = ctxWith(uiCtx());
    await lifecycle.get("session_start")?.({}, ctx);
    await lifecycle.get("agent_start")?.({}, ctx);
    await lifecycle.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    await lifecycle.get("agent_settled")?.({}, ctx);
    const entries = vi.mocked(pi.appendEntry).mock.calls;
    expect(entries[0]?.[0]).toBe("subagents:activity");
    expect(entries.at(-1)?.[0]).toBe("subagents:activity-final");
    await lifecycle.get("session_shutdown")?.({}, ctx);
  });
  it("waits for the next user message before appending the next card", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = ctxWith(uiCtx());
    await lifecycle.get("session_start")?.({}, ctx);
    await lifecycle.get("before_agent_start")?.({ prompt: "first" }, ctx);
    await lifecycle.get("agent_start")?.({}, ctx);
    await lifecycle.get("message_start")?.({ message: { role: "user" } }, ctx);
    await lifecycle.get("message_end")?.({ message: { role: "user" } }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await lifecycle.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    await lifecycle.get("agent_settled")?.({}, ctx);
    const activityEntries = () =>
      vi.mocked(pi.appendEntry).mock.calls.filter(([type]) => type === "subagents:activity");
    expect(activityEntries()).toHaveLength(1);
    await lifecycle.get("before_agent_start")?.({ prompt: "second" }, ctx);
    await lifecycle.get("agent_start")?.({}, ctx);
    expect(activityEntries()).toHaveLength(1);
    await lifecycle.get("message_start")?.({ message: { role: "user" } }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(activityEntries()).toHaveLength(2);
    await lifecycle.get("session_shutdown")?.({}, ctx);
  });
  it("keeps the card after a user message when lifecycle events are reordered", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = ctxWith(uiCtx());
    await lifecycle.get("session_start")?.({}, ctx);
    await lifecycle.get("message_end")?.({ message: { role: "user" } }, ctx);
    await lifecycle.get("before_agent_start")?.({ prompt: "inspect" }, ctx);
    await lifecycle.get("agent_start")?.({}, ctx);
    await lifecycle.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    await lifecycle.get("agent_settled")?.({}, ctx);
    const entries = vi.mocked(pi.appendEntry).mock.calls;
    expect(entries[0]?.[0]).toBe("subagents:activity");
    expect(entries.at(-1)?.[0]).toBe("subagents:activity-final");
    await lifecycle.get("session_shutdown")?.({}, ctx);
  });
});
