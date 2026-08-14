import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
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
    isIdle: () => true,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

describe("top-level foreground rejection", () => {
  afterEach(() => {
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    vi.clearAllMocks();
  });

  it("rejects explicit foreground execution before a child starts", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const result = await tools.get("Agent").execute(
      "foreground-call",
      {
        prompt: "do work",
        description: "Do work",
        subagent_type: "general-purpose",
        run_in_background: false,
      },
      undefined,
      undefined,
      ctx(),
    );

    expect(result.content[0].text).toContain("Foreground Agent execution is disabled");
    expect(result.terminate).toBeUndefined();
    expect(runAgent).not.toHaveBeenCalled();
    await lifecycle.get("session_shutdown")?.({}, ctx());
  });
});
