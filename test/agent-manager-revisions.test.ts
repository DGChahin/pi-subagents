import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  checkpointWorktree: vi.fn(),
  cleanupWorktree: vi.fn(),
  pruneWorktrees: vi.fn(),
}));

import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { streamToOutputFile, writeInitialEntry } from "../src/output-file.js";
import { checkpointWorktree, cleanupWorktree, createWorktree } from "../src/worktree.js";

const pi = {} as never;
const ctx = { cwd: "/repo" } as never;
const worktree = {
  path: "/tmp/pi-agent-resumable",
  branch: "pi-agent-resumable",
  baseSha: "base",
  workPath: "/tmp/pi-agent-resumable",
};

function session(messages: unknown[] = []) {
  return {
    messages,
    dispose: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    steer: vi.fn(() => Promise.resolve()),
  };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
};

describe("AgentManager revision lifecycle", () => {
  let manager: AgentManager | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createWorktree).mockReturnValue({ ...worktree });
    vi.mocked(checkpointWorktree).mockReturnValue({ status: "unchanged", hasChanges: false });
    vi.mocked(cleanupWorktree).mockReturnValue({ status: "unchanged", hasChanges: false });
  });

  afterEach(() => {
    manager?.dispose();
    vi.restoreAllMocks();
    manager = undefined;
  });

  it("opens one immutable resume revision only after exact settlement and consumption, through the shared queue", async () => {
    let resolveInitial: ((value: unknown) => void) | undefined;
    let resolveBlocker: ((value: unknown) => void) | undefined;
    let initialCallbacks: Parameters<typeof runAgent>[3] | undefined;
    const originalSession = session([{ role: "user", content: "first" }]);
    vi.mocked(runAgent)
      .mockImplementationOnce((_ctx, _type, _prompt, options) => {
        initialCallbacks = options;
        return new Promise(resolve => { resolveInitial = resolve; }) as never;
      })
      .mockImplementationOnce(() => new Promise(resolve => { resolveBlocker = resolve; }) as never);

    let releaseCheckpoint: ((value: unknown) => void) | undefined;
    vi.mocked(checkpointWorktree).mockImplementationOnce(
      () => new Promise(resolve => { releaseCheckpoint = resolve; }) as never,
    );
    vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed" });

    let generation = 1;
    manager = new AgentManager(undefined, 1, undefined, undefined, () => generation);
    const id = manager.spawn(pi, ctx, "general-purpose", "first", {
      description: "resumable",
      isBackground: true,
      isolation: "worktree",
    });
    const record = manager.getRecord(id)!;

    resolveInitial?.({
      responseText: "first result",
      session: originalSession,
      aborted: false,
      steered: false,
    });
    await flush();

    expect(record.status).toBe("completed");
    expect(record.runRevision).toBe(1);
    expect(record.settledRevision).toBeUndefined();
    expect(manager.resumeInBackground(id, "too early")).toBeUndefined();

    releaseCheckpoint?.({ status: "checkpointed", hasChanges: true, branch: worktree.branch, path: worktree.path });
    await record.promise;
    await flush();
    expect(record.settledRevision).toBe(1);
    expect(manager.resumeInBackground(id, "still unread")).toBeUndefined();

    record.resultConsumed = true;
    record.pendingDeliveryRevision = 1;
    expect(manager.resumeInBackground(id, "still pending delivery")).toBeUndefined();
    record.pendingDeliveryRevision = undefined;
    const blockerId = manager.spawn(pi, ctx, "general-purpose", "blocker", {
      description: "blocker",
      isBackground: true,
    });
    expect(manager.getRecord(blockerId)?.status).toBe("running");

    generation = 2;
    expect(manager.resumeInBackground(id, "continue")).toBe(record);
    expect(record).toEqual(expect.objectContaining({
      runRevision: 2,
      status: "queued",
      parentSessionGeneration: 2,
      worktree: expect.objectContaining({ path: worktree.path }),
    }));
    expect(resumeAgent).not.toHaveBeenCalled();

    initialCallbacks?.onToolActivity?.({ type: "end", toolName: "old-tool" });
    initialCallbacks?.onAssistantUsage?.({ input: 10, output: 5, cacheWrite: 1 });
    expect(record.toolUses).toBe(0);
    expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });

    generation = 3;
    resolveBlocker?.({
      responseText: "blocker done",
      session: session(),
      aborted: false,
      steered: false,
    });
    await manager.getRecord(blockerId)!.promise;
    await flush();

    expect(resumeAgent).toHaveBeenCalledWith(originalSession, "continue", expect.anything());
    expect(record.parentSessionGeneration).toBe(2);
    await record.promise;
    await flush();
    expect(record.settledRevision).toBe(2);
    expect(record.worktree?.path).toBe(worktree.path);
    expect(vi.mocked(checkpointWorktree).mock.calls.map(call => call[0].path)).toEqual([
      worktree.path,
      worktree.path,
    ]);
    expect(cleanupWorktree).not.toHaveBeenCalled();
  });

  it("appends only the resumed turn after the transcript history boundary", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-resume-transcript-"));
    try {
      const messages = [
        { role: "user", content: "first" },
        { role: "assistant", content: [{ type: "text", text: "first result" }] },
      ];
      let listener: ((event: { type: string }) => void) | undefined;
      const transcriptSession = {
        messages,
        subscribe: vi.fn((fn: (event: { type: string }) => void) => {
          listener = fn;
          return () => { listener = undefined; };
        }),
        dispose: vi.fn(),
        steer: vi.fn(() => Promise.resolve()),
      };
      vi.mocked(runAgent).mockResolvedValue({
        responseText: "first result",
        session: transcriptSession as never,
        aborted: false,
        steered: false,
      });
      vi.mocked(resumeAgent).mockImplementation(async () => {
        messages.push(
          { role: "user", content: "continue" },
          { role: "assistant", content: [{ type: "text", text: "resumed result" }] },
        );
        listener?.({ type: "turn_end" });
        return { text: "resumed result" };
      });

      manager = new AgentManager();
      const id = manager.spawn(pi, ctx, "general-purpose", "first", {
        description: "transcript",
        isBackground: true,
      });
      const record = manager.getRecord(id)!;
      await record.promise;
      await flush();

      const outputPath = join(tmp, "agent.output");
      writeInitialEntry(outputPath, id, "first", "/repo");
      streamToOutputFile(transcriptSession as never, outputPath, id, "/repo")();
      record.outputFile = outputPath;
      record.outputCwd = "/repo";
      record.outputPromptRevision = 1;
      record.resultConsumed = true;

      await manager.resume(id, "continue");

      const entries = readFileSync(outputPath, "utf-8")
        .trim()
        .split("\n")
        .map(line => JSON.parse(line) as { message: { role: string; content: unknown } });
      expect(entries.map(entry => entry.message.role)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(entries[2].message.content).toBe("continue");
      expect(JSON.stringify(entries[3].message.content)).toContain("resumed result");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("disposes settled descendants before their parent", async () => {
    const order: string[] = [];
    const parentSession = { ...session(), dispose: vi.fn(() => order.push("parent")) };
    const childSession = { ...session(), dispose: vi.fn(() => order.push("child")) };
    let finishParent: ((value: unknown) => void) | undefined;

    vi.mocked(runAgent).mockImplementation((_ctx, _type, prompt, options) => {
      if (prompt === "parent") {
        return new Promise(resolve => { finishParent = resolve; }) as never;
      }
      return new Promise(resolve => {
        options.signal?.addEventListener("abort", () => resolve({
          responseText: "",
          session: childSession,
          aborted: true,
          steered: false,
        }), { once: true });
      }) as never;
    });

    manager = new AgentManager();
    const parentId = manager.spawn(pi, ctx, "general-purpose", "parent", {
      description: "parent",
      isBackground: true,
    });
    const childId = manager.spawn(pi, ctx, "general-purpose", "child", {
      description: "child",
      isBackground: true,
      parentAgentId: parentId,
      depth: 2,
    });

    finishParent?.({
      responseText: "done",
      session: parentSession,
      aborted: false,
      steered: false,
    });
    await manager.getRecord(parentId)!.promise;
    await manager.getRecord(childId)!.promise;
    await flush();

    manager.dispose();
    manager = undefined;
    expect(order).toEqual(["child", "parent"]);
  });

  it.each(["checkpoint", "removal"] as const)(
    "retains the record and isolated path after %s failure",
    async (failurePoint) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const failure = {
        status: "failed" as const,
        path: worktree.path,
        error: `${failurePoint} failed`,
      };
      if (failurePoint === "checkpoint") {
        vi.mocked(checkpointWorktree).mockReturnValue(failure);
      } else {
        vi.mocked(cleanupWorktree).mockReturnValue(failure);
      }
      vi.mocked(runAgent).mockResolvedValue({
        responseText: "recoverable work",
        session: session(),
        aborted: false,
        steered: false,
      });

      manager = new AgentManager();
      const id = manager.spawn(pi, ctx, "general-purpose", "work", {
        description: "recoverable",
        isBackground: true,
        isolation: "worktree",
      });
      const record = manager.getRecord(id)!;
      await record.promise;
      await flush();
      record.resultConsumed = true;
      manager.clearCompleted();

      expect(manager.getRecord(id)).toBe(record);
      expect(record.worktree?.path).toBe(worktree.path);
      expect(record.worktreeResult).toEqual(failure);
      expect(record.result).toContain(worktree.path);
      expect(record.result).toContain(`${failurePoint} failed`);
    },
  );
});
