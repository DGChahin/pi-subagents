/**
 * Top-level get_subagent_result reports unsettled work immediately. The
 * completion callback remains the delivery path for the eventual result.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
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
    events: {
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function ctx() {
  return {
    hasUI: false,
    isIdle: () => true,
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
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

const timedOut = Symbol("timed out");
async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      promise,
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), 100);
      }),
    ]);
    expect(result).not.toBe(timedOut);
    if (result === timedOut) throw new Error("operation did not resolve promptly");
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function hasNotification(pi: any, id: string): boolean {
  return pi.sendMessage.mock.calls.some(
    ([message]: any[]) =>
      message?.customType === "subagent-notification" &&
      typeof message.content === "string" &&
      message.content.includes(id),
  );
}

async function waitForNotification(pi: any, id: string): Promise<void> {
  for (let i = 0; i < 40 && !hasNotification(pi, id); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** runAgent mock where each call blocks until its resolver is invoked. */
function deferredRuns() {
  const resolvers: Array<() => void> = [];
  vi.mocked(runAgent).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvers.push(() =>
          resolve({
            responseText: "THE-RESULT-PAYLOAD",
            session: { dispose: vi.fn() } as any,
            aborted: false,
            steered: false,
          }),
        );
      }) as any,
  );
  return resolvers;
}

async function spawnBackground(tools: Map<string, any>): Promise<{ id: string; queued: boolean }> {
  const r = await tools.get("Agent").execute(
    "tc-spawn",
    {
      prompt: "go",
      description: "queued-wait test agent",
      subagent_type: "general-purpose",
      run_in_background: true,
    },
    undefined,
    undefined,
    ctx(),
  );
  const id = /Agent ID: (\S+)/.exec(textOf(r))![1];
  return { id, queued: textOf(r).includes("queued in background") };
}

let hermetic: Hermetic | undefined;

beforeEach(() => {
  hermetic = hermeticDir({
    settings: { maxConcurrent: 1, defaultJoinMode: "async", schedulingEnabled: false, outputTranscript: false },
  });
  vi.mocked(runAgent).mockReset();
});

afterEach(() => {
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  hermetic?.restore();
  hermetic = undefined;
});

describe("top-level get_subagent_result wait semantics", () => {
  it("returns a running result promptly and leaves its completion callback armed", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")?.({}, ctx());
    const resolvers = deferredRuns();
    const { id } = await spawnBackground(tools);

    const result = await promptly(
      tools
        .get("get_subagent_result")
        .execute("tc-wait-running", { agent_id: id, wait: true }, undefined, undefined, ctx()),
    );
    expect(textOf(result)).toContain("Agent is running");
    expect(result.terminate).toBe(true);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(resolvers).toHaveLength(1);

    resolvers.shift()!();
    await flush();
    await waitForNotification(pi, id);
    expect(hasNotification(pi, id)).toBe(true);

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("returns a queued result promptly and delivers its callback after queue drain", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")?.({}, ctx());
    const resolvers = deferredRuns();

    const first = await spawnBackground(tools);
    const queued = await spawnBackground(tools);
    expect(first.queued).toBe(false);
    expect(queued.queued).toBe(true);

    const result = await promptly(
      tools
        .get("get_subagent_result")
        .execute("tc-wait-queued", { agent_id: queued.id, wait: true }, undefined, undefined, ctx()),
    );
    expect(textOf(result)).toContain("Agent is queued");
    expect(result.terminate).toBe(true);
    expect(hasNotification(pi, queued.id)).toBe(false);

    const firstResolver = resolvers.shift();
    expect(firstResolver).toBeDefined();
    firstResolver!();
    await flush();
    expect(runAgent).toHaveBeenCalledTimes(2);
    const queuedResolver = resolvers.shift();
    expect(queuedResolver).toBeDefined();
    expect(hasNotification(pi, queued.id)).toBe(false);

    queuedResolver!();
    await flush();
    await waitForNotification(pi, queued.id);
    expect(hasNotification(pi, queued.id)).toBe(true);

    const terminal = await tools
      .get("get_subagent_result")
      .execute("tc-read-queued", { agent_id: queued.id, wait: true }, undefined, undefined, ctx());
    expect(textOf(terminal)).toContain("THE-RESULT-PAYLOAD");
    expect(terminal.terminate).toBeUndefined();

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("keeps wait:false immediate and non-terminating for a running agent", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")?.({}, ctx());
    const resolvers = deferredRuns();
    const { id } = await spawnBackground(tools);

    const result = await promptly(
      tools
        .get("get_subagent_result")
        .execute("tc-poll-running", { agent_id: id, wait: false }, undefined, undefined, ctx()),
    );
    expect(textOf(result)).toContain("Agent is still running");
    expect(result.terminate).toBeUndefined();
    expect(pi.sendMessage).not.toHaveBeenCalled();

    resolvers.shift()!();
    await flush();
    await lifecycle.get("session_shutdown")?.({}, ctx());
  });
});
