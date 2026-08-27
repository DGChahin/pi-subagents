import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { setOutputTranscriptDefault } from "../src/output-file.js";

interface Harness {
  pi: {
    events: { emit: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
    appendEntry: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
  };
  tools: Map<string, { execute: (...args: unknown[]) => Promise<Record<string, unknown>> }>;
  lifecycle: Map<string, (...args: unknown[]) => unknown>;
}

function makePi(): Harness {
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<Record<string, unknown>> }>();
  const lifecycle = new Map<string, (...args: unknown[]) => unknown>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const emit = vi.fn((event: string, payload: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(payload);
  });
  const onEvent = vi.fn((event: string, listener: (payload: unknown) => void) => {
    const eventListeners = listeners.get(event) ?? new Set();
    eventListeners.add(listener);
    listeners.set(event, eventListeners);
    return () => eventListeners.delete(listener);
  });
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerMarkdownTransformer: vi.fn(),
    registerTool: vi.fn((tool: { name: string; execute: (...args: unknown[]) => Promise<Record<string, unknown>> }) => {
      tools.set(tool.name, tool);
    }),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => lifecycle.set(event, handler)),
    events: { emit, on: onEvent },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  };
  return { pi, tools, lifecycle } as Harness;
}

function makeCtx(sessionId: string, idle: () => boolean) {
  return {
    hasUI: false,
    isIdle: idle,
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
    sessionManager: { getSessionId: vi.fn(() => sessionId), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  };
}

function resultText(result: Record<string, unknown>): string {
  return ((result.content as Array<{ text: string }>)[0]).text;
}

function idFrom(result: Record<string, unknown>): string {
  const id = /Agent ID: (\S+)/.exec(resultText(result))?.[1];
  expect(id).toBeTruthy();
  return id!;
}

function agentResult(text: string, messages: unknown[] = []) {
  return {
    responseText: text,
    session: {
      messages,
      dispose: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
      steer: vi.fn(() => Promise.resolve()),
    },
    aborted: false,
    steered: false,
  };
}

const microflush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const flush = async () => {
  await microflush();
  await new Promise(resolve => setImmediate(resolve));
};

describe("top-level background lifecycle and idle completion delivery", () => {
  let cwd: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-idle-callbacks-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-idle-callbacks-agent-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    process.chdir(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    vi.mocked(runAgent).mockReset();
    vi.mocked(resumeAgent).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")];
    setOutputTranscriptDefault(true);
    process.chdir(previousCwd);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  function boot(settings: Record<string, unknown> = {}): Harness {
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({
      schedulingEnabled: false,
      outputTranscript: false,
      ...settings,
    }));
    const harness = makePi();
    subagentsExtension(harness.pi as never);
    return harness;
  }

  async function spawn(
    tools: Harness["tools"],
    prompt: string,
    context: ReturnType<typeof makeCtx>,
    extra: Record<string, unknown> = {},
  ) {
    return tools.get("Agent")!.execute(
      `call-${prompt}`,
      { prompt, description: prompt, subagent_type: "general-purpose", ...extra },
      undefined,
      undefined,
      context,
    );
  }

  it("defaults top-level dispatch and resume to background and shares one concurrency queue", async () => {
    const harness = boot({ maxConcurrent: 1, defaultJoinMode: "async" });
    const context = makeCtx("session-1", () => true);
    await harness.lifecycle.get("session_start")?.({}, context);

    let finishBlocker: ((value: unknown) => void) | undefined;
    vi.mocked(runAgent)
      .mockResolvedValueOnce(agentResult("first result") as never)
      .mockImplementationOnce(() => new Promise(resolve => { finishBlocker = resolve; }) as never);
    vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed result" });

    const first = await spawn(harness.tools, "first", context);
    const firstId = idFrom(first);
    expect(first.terminate).toBe(true);
    await flush();
    const consumed = await harness.tools.get("get_subagent_result")!.execute(
      "get-first", { agent_id: firstId, wait: true }, undefined, undefined, context,
    );
    expect(resultText(consumed)).toContain("first result");

    const blocker = await spawn(harness.tools, "blocker", context);
    expect(blocker.terminate).toBe(true);

    const resumed = await spawn(harness.tools, "continue", context, { resume: firstId });
    expect(resultText(resumed)).toContain("resume queued");
    expect(idFrom(resumed)).toBe(firstId);
    expect(resumed.terminate).toBe(true);
    expect(resumeAgent).not.toHaveBeenCalled();

    const duplicate = await spawn(harness.tools, "duplicate", context, { resume: firstId });
    expect(resultText(duplicate)).toContain("still queued");
    expect(duplicate.terminate).toBeUndefined();

    finishBlocker?.(agentResult("blocker done"));
    await flush();
    expect(resumeAgent).toHaveBeenCalledWith(expect.anything(), "continue", expect.anything());

    const manager = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as {
      getRecord(id: string): { promise?: Promise<string>; runRevision: number } | undefined;
    };
    await manager.getRecord(firstId)?.promise;
    expect(manager.getRecord(firstId)?.runRevision).toBe(2);
    await harness.lifecycle.get("session_shutdown")?.({}, context);
  });

  it("suppresses completion events, history appends, and callbacks from an old parent generation", async () => {
    const harness = boot({ defaultJoinMode: "async" });
    const oldContext = makeCtx("old-session", () => true);
    const newContext = makeCtx("new-session", () => true);
    await harness.lifecycle.get("session_start")?.({}, oldContext);

    let finish: ((value: unknown) => void) | undefined;
    vi.mocked(runAgent).mockImplementation(() => new Promise(resolve => { finish = resolve; }) as never);
    const dispatched = await spawn(harness.tools, "old work", oldContext);
    const id = idFrom(dispatched);

    await harness.lifecycle.get("session_before_switch")?.({}, oldContext);
    await harness.lifecycle.get("session_start")?.({}, newContext);
    harness.pi.events.emit.mockClear();
    harness.pi.appendEntry.mockClear();
    harness.pi.sendMessage.mockClear();

    finish?.(agentResult("late result"));
    await flush();

    expect(harness.pi.events.emit).not.toHaveBeenCalledWith("subagents:completed", expect.objectContaining({ id }));
    expect(harness.pi.events.emit).not.toHaveBeenCalledWith("subagents:failed", expect.objectContaining({ id }));
    expect(harness.pi.appendEntry).not.toHaveBeenCalledWith("subagents:record", expect.objectContaining({ id }));
    expect(harness.pi.sendMessage).not.toHaveBeenCalled();
    await harness.lifecycle.get("session_shutdown")?.({}, newContext);
  });

  it("removes retrieved revisions from batch, group, and pending-nudge state", async () => {
    vi.useFakeTimers();
    const harness = boot({ defaultJoinMode: "smart" });
    const context = makeCtx("session-1", () => true);
    await harness.lifecycle.get("session_start")?.({}, context);

    const resolvers = new Map<string, (value: unknown) => void>();
    vi.mocked(runAgent).mockImplementation((_ctx, _type, prompt) =>
      new Promise(resolve => resolvers.set(prompt, resolve)) as never,
    );

    const batchA = idFrom(await spawn(harness.tools, "batch-a", context));
    const batchB = idFrom(await spawn(harness.tools, "batch-b", context));
    resolvers.get("batch-a")?.(agentResult("batch-a result"));
    resolvers.get("batch-b")?.(agentResult("batch-b result"));
    await microflush();
    await harness.tools.get("get_subagent_result")!.execute(
      "get-batch-a", { agent_id: batchA, wait: true }, undefined, undefined, context,
    );
    await vi.advanceTimersByTimeAsync(100);
    await harness.tools.get("get_subagent_result")!.execute(
      "get-batch-b", { agent_id: batchB, wait: true }, undefined, undefined, context,
    );
    await vi.advanceTimersByTimeAsync(200);

    const groupA = idFrom(await spawn(harness.tools, "group-a", context));
    const groupB = idFrom(await spawn(harness.tools, "group-b", context));
    await vi.advanceTimersByTimeAsync(100);
    resolvers.get("group-a")?.(agentResult("group-a result"));
    await microflush();
    await harness.tools.get("get_subagent_result")!.execute(
      "get-group-a", { agent_id: groupA, wait: true }, undefined, undefined, context,
    );
    resolvers.get("group-b")?.(agentResult("group-b result"));
    await microflush();
    await harness.tools.get("get_subagent_result")!.execute(
      "get-group-b", { agent_id: groupB, wait: true }, undefined, undefined, context,
    );
    await vi.advanceTimersByTimeAsync(200);

    expect(harness.pi.sendMessage).not.toHaveBeenCalled();
    await harness.lifecycle.get("session_shutdown")?.({}, context);
  });
});
