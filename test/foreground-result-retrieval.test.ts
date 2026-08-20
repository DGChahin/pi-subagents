/**
 * Top-level Agent execution is background-only in this fork. These tests keep
 * issue #174's record-identity and eviction coverage on the supported result
 * retrieval path while pinning explicit foreground rejection.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const textOf = (result: any): string => result.content[0].text;

async function runBackgroundSteeredAgent(tools: Map<string, any>) {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "THE-RESULT-PAYLOAD",
    session: {
      messages: [],
      subscribe: vi.fn(() => vi.fn()),
      dispose: vi.fn(),
    } as any,
    aborted: false,
    steered: true,
  });
  const receipt = await tools.get("Agent").execute(
    "tc-bg",
    {
      prompt: "Perform a very thorough read-only codebase exploration.",
      description: "Locate organization-scope changes",
      subagent_type: "Explore",
      max_turns: 20,
    },
    undefined,
    undefined,
    ctx(),
  );
  const id = /Agent ID: (\S+)/.exec(textOf(receipt))?.[1];
  expect(id, "background spawn should expose its record id").toBeTruthy();
  return { receipt, id: id as string };
}

describe("top-level background result identity and foreground rejection", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-174-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-174-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    vi.restoreAllMocks();
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

    expect(textOf(result)).toContain("Foreground Agent execution is disabled");
    expect(result.terminate).toBeUndefined();
    expect(runAgent).not.toHaveBeenCalled();
    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("keeps a completed record retrievable by the real id", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { id } = await runBackgroundSteeredAgent(tools);

    const read = await tools.get("get_subagent_result").execute(
      "tc-read",
      { agent_id: id, wait: true },
      undefined,
      undefined,
      ctx(),
    );
    expect(textOf(read)).not.toContain("Agent not found");
    expect(textOf(read)).toContain("wrapped up at the turn limit");
    expect(textOf(read)).toContain("THE-RESULT-PAYLOAD");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("hands the model the real id in content and rejects an invented id", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { receipt, id } = await runBackgroundSteeredAgent(tools);

    expect(textOf(receipt)).toContain(`Agent ID: ${id}`);

    const bogus = await tools.get("get_subagent_result").execute(
      "tc-bogus",
      { agent_id: "3f1320a7-74ec-422" },
      undefined,
      undefined,
      ctx(),
    );
    expect(textOf(bogus)).toContain("Agent not found");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("survives another extension activation's lifecycle", async () => {
    const parent = makePi();
    subagentsExtension(parent.pi);
    await parent.lifecycle.get("session_start")?.({}, ctx());
    const { id } = await runBackgroundSteeredAgent(parent.tools);

    const other = makePi();
    subagentsExtension(other.pi);
    await other.lifecycle.get("session_start")?.({}, ctx());
    await other.lifecycle.get("session_shutdown")?.({}, ctx());

    const read = await parent.tools.get("get_subagent_result").execute(
      "tc-read",
      { agent_id: id, wait: true },
      undefined,
      undefined,
      ctx(),
    );
    expect(textOf(read)).not.toContain("Agent not found");
    expect(textOf(read)).toContain("THE-RESULT-PAYLOAD");

    await parent.lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("evicts a consumed completed record on session switch", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { id } = await runBackgroundSteeredAgent(tools);

    const consumed = await tools.get("get_subagent_result").execute(
      "tc-read",
      { agent_id: id, wait: true },
      undefined,
      undefined,
      ctx(),
    );
    expect(textOf(consumed)).toContain("THE-RESULT-PAYLOAD");

    await lifecycle.get("session_before_switch")?.();

    const missing = await tools.get("get_subagent_result").execute(
      "tc-read-again",
      { agent_id: id },
      undefined,
      undefined,
      ctx(),
    );
    expect(textOf(missing)).toContain("Agent not found");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });
});
