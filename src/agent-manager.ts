/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are queued and auto-started as running agents complete.
 * Foreground agents bypass the queue (they block the parent anyway), and so do
 * nested children — see `occupiesPoolSlot`.
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import { streamToOutputFile } from "./output-file.js";
import type { AgentInvocation, AgentRecord, IsolationMode, SubagentType, ThinkingLevel } from "./types.js";
import type { AgentActivityEvent } from "./ui/activity-card.js";
import { addUsage, type UsageDelta } from "./usage.js";
import {
  checkpointWorktree,
  cleanupWorktree,
  createWorktree,
  pruneWorktrees,
  type WorktreeCleanupResult,
  type WorktreeInfo,
} from "./worktree.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
export type OnAgentSpawn = (record: AgentRecord) => void;
export type OnAgentFinish = (record: AgentRecord) => void;
export type OnAgentActivity = (record: AgentRecord, event: AgentActivityEvent) => void;
export type CaptureParentGeneration = () => number;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

/** Default max concurrent background agents. */
const DEFAULT_MAX_CONCURRENT = 4;

/**
 * Validate a caller-supplied SpawnOptions.cwd. `undefined`/`null` mean "unset"
 * (parent cwd). Anything else must be an absolute path to an existing
 * directory — curated errors instead of TypeErrors from path/fs internals
 * (RPC callers send arbitrary JSON: null, numbers, file paths).
 */
function assertValidSpawnCwd(cwd: unknown): asserts cwd is string | undefined | null {
  if (cwd == null) return;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new Error(`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`);
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
  }
  if (!isDirectory) {
    throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
  }
}

/**
 * Whether a record occupies one of the `maxConcurrent` background slots.
 * Nested children don't: their parent already holds a slot, so counting (and
 * therefore queueing) them would deadlock a parent that waits on its own child.
 *
 * Note this bounds nothing horizontally — the depth cap limits how DEEP nesting
 * goes, not how WIDE. A parent's only limit on concurrent children is that each
 * spawn costs it a turn, which is unbounded when max turns is unlimited.
 */
function occupiesPoolSlot(record: Pick<AgentRecord, "isBackground" | "parentAgentId">): boolean {
  return !!record.isBackground && record.parentAgentId === undefined;
}

function worktreeCheckpointFailure(path: string, err: unknown): WorktreeCleanupResult {
  return {
    status: "failed",
    path,
    error: err instanceof Error ? err.message : String(err),
  };
}

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

type QueueEntry =
  | { kind: "spawn"; id: string; args: SpawnArgs }
  | { kind: "resume"; id: string; prompt: string; revision: number };

interface SpawnOptions {
  description: string;
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  /**
   * Skip the maxConcurrent queue check for this spawn — start immediately even
   * if the configured concurrency limit would otherwise queue it. Used by the
   * scheduler so a fired job can't be deferred past its trigger window.
   */
  bypassQueue?: boolean;
  /** Isolation mode — "worktree" creates a temp git worktree for the agent. */
  isolation?: IsolationMode;
  /**
   * Working directory for the agent (absolute path). Default: parent session
   * cwd. The agent's tools operate here, but .pi config (extensions, skills,
   * settings, memory) still loads from the parent session's project — the
   * target directory's `.pi` extensions never execute. With isolation:
   * "worktree", the worktree is created FROM this directory and the result
   * branch lands in that repo.
   */
  cwd?: string;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called on streaming thinking deltas from the assistant response. */
  onThinkingDelta?: (delta: string, fullThinking: string) => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: UsageDelta) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
  /** Nesting depth: top-level subagent = 1. */
  depth?: number;
  /** Parent agent ID for ownership-scoped nested controls. */
  parentAgentId?: string;
  /** Effective inherited nesting cap for this branch. */
  maxSubagentDepth?: number;
  /** Config-discovery root inherited by nested launches when it differs from the working directory. */
  configCwd?: string;
  /** Root session id, inherited by nested launches so transcripts stay grouped. */
  rootSessionId?: string;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private onSpawn?: OnAgentSpawn;
  private onFinish?: OnAgentFinish;
  private onActivity?: OnAgentActivity;
  private captureParentGeneration?: CaptureParentGeneration;
  private maxConcurrent: number;
  /** Base repos worktrees were created from — so dispose() can prune them all,
   *  not just the parent repo (caller-supplied cwd can target other repos). */
  private worktreeRepos = new Set<string>();

  /** Queue of background agents and resumed turns waiting to start. */
  private queue: QueueEntry[] = [];
  /** Number of currently running background agents. */
  private runningBackground = 0;

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
    captureParentGeneration?: CaptureParentGeneration,
    onSpawn?: OnAgentSpawn,
    onFinish?: OnAgentFinish,
    onActivity?: OnAgentActivity,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.captureParentGeneration = captureParentGeneration;
    this.onSpawn = onSpawn;
    this.onFinish = onFinish;
    this.onActivity = onActivity;
    this.maxConcurrent = maxConcurrent;
    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  /** Update the max concurrent background agents limit. */
  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    // Start queued agents if the new limit allows
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    // Validate before the queue branch — a queued spawn should fail at the
    // call, not minutes later at drain. Throw (not warn): programmatic callers
    // can fix and retry; the RPC layer converts throws into error envelopes.
    assertValidSpawnCwd(options.cwd);

    const id = randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type,
      description: options.description,
      status: options.isBackground ? "queued" : "running",
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      runRevision: 1,
      // Raw tri-state (not coerced to a boolean): true = background, false =
      // foreground (has an inline tool-result surface), undefined = caller never
      // declared it (e.g. a cross-extension RPC spawn). The widget's background-
      // only filter excludes only explicit `false`, so undefined agents — which
      // have no inline surface — stay visible instead of vanishing.
      isBackground: options.isBackground,
      invocation: options.invocation,
      depth: options.depth ?? 1,
      parentAgentId: options.parentAgentId,
      parentRunRevision: options.parentAgentId === undefined
        ? undefined
        : this.agents.get(options.parentAgentId)?.runRevision,
      maxSubagentDepth: options.maxSubagentDepth,
      rootSessionId: options.rootSessionId,
      // Capture before the queue decision. A queued top-level run belongs to
      // the parent session that dispatched it, not the session active when it starts.
      parentSessionGeneration: options.parentAgentId === undefined
        ? this.captureParentGeneration?.()
        : undefined,
    };
    this.agents.set(id, record);
    this.onSpawn?.(record);

    const args: SpawnArgs = { pi, ctx, type, prompt, options };

    if (occupiesPoolSlot(record) && !options.bypassQueue && this.runningBackground >= this.maxConcurrent) {
      // Queue it — will be started when a running agent completes
      this.queue.push({ kind: "spawn", id, args });
      return id;
    }

    // startAgent can throw (e.g. strict worktree-isolation failure) — clean
    // up the record so callers don't see an orphan in `listAgents()`.
    try {
      this.startAgent(id, record, args);
    } catch (err) {
      record.status = "error";
      record.error = err instanceof Error ? err.message : String(err);
      record.completedAt = Date.now();
      record.settledRevision = record.runRevision;
      try { this.onFinish?.(record); } catch { /* ignore activity side-effect errors */ }
      this.agents.delete(id);
      throw err;
    }
    return id;
  }

  /** Actually start an agent (called immediately or from queue drain). */
  private startAgent(id: string, record: AgentRecord, { pi, ctx, type, prompt, options }: SpawnArgs) {
    // Re-validate a caller-supplied cwd: queued spawns can start minutes after
    // spawn()'s check, and the directory may be gone by then (TOCTOU). Same
    // curated errors; drainQueue parks a throw on the record as an error.
    assertValidSpawnCwd(options.cwd);
    // Single resolution point for the caller-supplied cwd. Retained worktree
    // checkpoint and definitive cleanup must keep this base repo identity.
    const customCwd = options.cwd ?? undefined; // null (RPC "unset") → undefined
    const baseCwd = customCwd ?? ctx.cwd;

    // Worktree isolation: try to create a temporary git worktree. Strict —
    // fail loud if not possible (no silent fallback to main tree). Done
    // BEFORE state mutation so a throw doesn't leave the record half-running.
    let worktreeCwd: string | undefined;
    if (options.isolation === "worktree") {
      const wt = createWorktree(baseCwd, id);
      if (!wt) {
        throw new Error(
          'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
          'Initialize git and commit at least once, or omit `isolation`.',
        );
      }
      record.worktree = wt;
      record.worktreeRevision = record.runRevision;
      record.worktreeBaseCwd = baseCwd;
      record.worktreeHasCustomCwd = customCwd !== undefined;
      // workPath preserves subdirectory scoping for caller-supplied cwds: a
      // cwd deep in a monorepo maps to the same subdir inside the copy, not
      // the copied repo's root. Plain worktree spawns keep the historical
      // behavior (agent at the copy's root) — moving them to workPath would
      // also move .pi config discovery when the parent session sits in a repo
      // subdirectory, silently dropping extensions/skills.
      worktreeCwd = customCwd !== undefined ? wt.workPath : wt.path;
      this.worktreeRepos.add(baseCwd);
    }

    record.status = "running";
    record.startedAt = Date.now();
    if (occupiesPoolSlot(record)) this.runningBackground++;
    this.onStart?.(record);
    this.onActivity?.(record, { type: "start" });

    // Wire parent abort signal to stop the subagent when the parent is interrupted
    let detachParentSignal: (() => void) | undefined;
    if (options.signal) {
      const onParentAbort = () => this.abort(id);
      options.signal.addEventListener("abort", onParentAbort, { once: true });
      detachParentSignal = () => options.signal!.removeEventListener("abort", onParentAbort);
    }
    const detach = () => { detachParentSignal?.(); detachParentSignal = undefined; };
    const runRevision = record.runRevision;
    const revisionWorktree = record.worktree;

    const promise = runAgent(ctx, type, prompt, {
      pi,
      agentId: id,
      model: options.model,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      inheritContext: options.inheritContext,
      thinkingLevel: options.thinkingLevel,
      // Worktree wins for the working dir (the agent must run in the copy —
      // which, with a custom cwd, was created from that target). Config stays
      // with the parent project when a caller-supplied cwd is in play; it must
      // stay undefined otherwise so plain worktree runs keep resolving config
      // (incl. relative extension paths and memory) inside the worktree copy.
      cwd: worktreeCwd ?? customCwd,
      configCwd: options.configCwd ?? (customCwd !== undefined ? ctx.cwd : undefined),
      signal: record.abortController!.signal,
      onToolActivity: (activity) => {
        if (record.runRevision !== runRevision) return;
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
        this.onActivity?.(record, { type: "tool", activity });
      },
      onTurnEnd: (turnCount) => {
        if (record.runRevision === runRevision) {
          options.onTurnEnd?.(turnCount);
          this.onActivity?.(record, { type: "turn", turnCount });
        }
      },
      onTextDelta: (delta, fullText) => {
        if (record.runRevision === runRevision) {
          options.onTextDelta?.(delta, fullText);
          this.onActivity?.(record, { type: "text", fullText });
        }
      },
      onThinkingDelta: (delta, fullThinking) => {
        if (record.runRevision === runRevision) {
          options.onThinkingDelta?.(delta, fullThinking);
          this.onActivity?.(record, { type: "thinking", fullText: fullThinking });
        }
      },
      onAssistantUsage: (usage) => {
        if (record.runRevision !== runRevision) return;
        addUsage(record.lifetimeUsage, usage);
        options.onAssistantUsage?.(usage);
        this.onActivity?.(record, { type: "usage", usage });
      },
      onCompaction: (info) => {
        if (record.runRevision !== runRevision) return;
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
        this.onActivity?.(record, { type: "compaction", info });
      },
      nestedRuntime: {
        manager: this,
        parentAgentId: id,
        depth: record.depth ?? 1,
        maxSubagentDepth: record.maxSubagentDepth,
      },
      onSessionCreated: (session) => {
        record.session = session;
        // Flush any steers that arrived before the session was ready
        if (record.pendingSteers?.length) {
          for (const msg of record.pendingSteers) {
            session.steer(msg).catch(() => {});
          }
          record.pendingSteers = undefined;
        }
        options.onSessionCreated?.(session);
        this.onActivity?.(record, { type: "session" });
      },
    })
      .then(async ({ responseText, session, aborted, steered, failure }) => {
        const isCurrent = record.runRevision === runRevision;
        if (isCurrent) {
          // Don't overwrite status if externally stopped via abort().
          if (record.status !== "stopped") {
            if (aborted) {
              record.status = "aborted";
            } else if (failure) {
              record.status = "error";
              record.error = failure;
            } else {
              record.status = steered ? "steered" : "completed";
            }
          }
          record.result = responseText;
          record.session = session;
          record.completedAt ??= Date.now();
        }

        detach();
        const wtResult = await this.settleRevisionArtifacts(record, runRevision, revisionWorktree);
        if (record.runRevision !== runRevision) return responseText;

        this.applyWorktreeResult(record, wtResult, baseCwd, customCwd !== undefined);
        return responseText;
      }, async (err) => {
        const isCurrent = record.runRevision === runRevision;
        if (isCurrent) {
          if (record.status !== "stopped") record.status = "error";
          record.error = err instanceof Error ? err.message : String(err);
          record.completedAt ??= Date.now();
        }

        detach();
        const wtResult = await this.settleRevisionArtifacts(record, runRevision, revisionWorktree);
        if (record.runRevision !== runRevision) return "";

        this.applyWorktreeResult(record, wtResult, baseCwd, customCwd !== undefined);
        return "";
      });

    record.promise = promise;
    // The marker is a reaction to `record.promise`, so the exact revision's
    // public promise is already settled before consumption or resume can open.
    void promise.then(() => {
      if (record.runRevision === runRevision) {
        record.settledRevision = runRevision;
        if (!options.isBackground) record.resultConsumed = true;
        try { this.onFinish?.(record); } catch { /* ignore activity side-effect errors */ }
        try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
      }
      if (options.isBackground && occupiesPoolSlot(record)) this.runningBackground--;
      if (options.isBackground) this.drainQueue();
    });

    // Notify caller that spawn is complete (record is in the map, promise is set).
    // Called synchronously — onSessionCreated fires asynchronously inside runAgent.
    // Used by spawnAndWait to let the caller set up output files before streaming starts.
    this.onSpawned?.(id);
  }

  private async settleRevisionArtifacts(
    record: AgentRecord,
    revision: number,
    worktree?: WorktreeInfo,
  ): Promise<WorktreeCleanupResult | undefined> {
    const outputCleanup = record.outputCleanup;
    if (outputCleanup && (record.outputCleanupRevision ?? revision) === revision) {
      try { outputCleanup(); } catch { /* ignore transcript flush errors */ }
      if (record.outputCleanup === outputCleanup) {
        record.outputCleanup = undefined;
        record.outputCleanupRevision = undefined;
      }
    }

    // Revision-owned children can share the parent's isolated worktree. Stop
    // every child writer before taking the parent's checkpoint.
    const childSettlementError = await this.abortOwnedChildren(record.id, revision);

    if (!worktree) return undefined;
    if (childSettlementError) {
      return worktreeCheckpointFailure(worktree.path, childSettlementError);
    }
    try {
      return checkpointWorktree(worktree, record.description);
    } catch (err) {
      return worktreeCheckpointFailure(worktree.path, err);
    }
  }

  private applyWorktreeResult(
    record: AgentRecord,
    result: WorktreeCleanupResult | undefined,
    baseCwd: string,
    hasCustomCwd: boolean,
    failureOperation: "checkpoint" | "cleanup" = "checkpoint",
  ): void {
    if (!result) return;
    const previous = record.worktreeResult;
    record.worktreeResult = result;

    if (result.status === "failed") {
      const sameFailure = previous?.status === "failed"
        && previous.path === result.path
        && previous.error === result.error;
      if (!sameFailure) {
        record.result = (record.result ?? "")
          + `\n\n---\nWorktree ${failureOperation} failed. Changes retained at \`${result.path}\`.\nError: ${result.error}`;
      }
      console.warn(`[pi-subagents] Worktree ${failureOperation} failed; retained at ${result.path}: ${result.error}`);
      return;
    }
    if (result.status !== "checkpointed") return;

    const repoNote = hasCustomCwd ? ` in \`${baseCwd}\`` : "";
    const mergeCwd = hasCustomCwd ? ` (run in \`${baseCwd}\`)` : "";
    record.result = (record.result ?? "")
      + `\n\n---\nChanges saved to branch \`${result.branch}\`${repoNote}. Merge with: \`git merge ${result.branch}\`${mergeCwd}`;
  }

  /** Stop and settle only the nested children created by one exact parent run. */
  private async abortOwnedChildren(parentId: string, parentRevision: number): Promise<string | undefined> {
    const owned: { id: string; record: AgentRecord; revision: number; promise?: Promise<string> }[] = [];
    for (const [id, record] of this.agents) {
      if (record.parentAgentId !== parentId || record.parentRunRevision !== parentRevision) continue;
      const revision = record.runRevision;
      this.abort(id);
      owned.push({ id, record, revision, promise: record.promise });
    }
    await Promise.allSettled(owned.flatMap(child => child.promise ? [child.promise] : []));

    const unsettled = owned.filter(
      child => child.record.runRevision !== child.revision
        || child.record.settledRevision !== child.revision,
    );
    if (unsettled.length === 0) return undefined;
    return `Revision-owned child agents did not settle: ${unsettled.map(child => `${child.id}@${child.revision}`).join(", ")}`;
  }

  /** Start queued agents and resumed turns up to the concurrency limit. */
  private drainQueue() {
    while (this.queue.length > 0 && this.runningBackground < this.maxConcurrent) {
      const next = this.queue.shift()!;
      const record = this.agents.get(next.id);
      if (!record || record.status !== "queued") continue;
      if (next.kind === "resume") {
        if (record.runRevision === next.revision) {
          this.startBackgroundResume(record, next.prompt, next.revision);
        }
        continue;
      }
      try {
        this.startAgent(next.id, record, next.args);
      } catch (err) {
        // Late failure (e.g. strict worktree-isolation) — surface on the record
        // so the user/agent can see it via /agents, then keep draining.
        record.status = "error";
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt = Date.now();
        record.settledRevision = record.runRevision;
        try { this.onFinish?.(record); } catch { /* ignore activity side-effect errors */ }
        this.onComplete?.(record);
      }
    }
  }

  /**
   * Called synchronously right after spawn, before onSessionCreated fires.
   * Lets the caller set up the output file path on the record.
   * The record is guaranteed to be in this.agents at this point.
   */
  private onSpawned?: (id: string) => void;

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Foreground agents bypass the concurrency queue.
   * Returns { id, record } so callers can access the agent ID.
   *
   * @param onSpawned - Called synchronously after spawn(), before onSessionCreated fires.
   *   Use this to set record.outputFile so streamToOutputFile can pick it up.
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
    onSpawned?: (id: string) => void,
  ): Promise<{ id: string; record: AgentRecord }> {
    // Temporarily register the onSpawned hook so startAgent can call it.
    const prevOnSpawned = this.onSpawned;
    this.onSpawned = onSpawned;
    let id: string;
    try {
      // spawn() invokes onSpawned synchronously before returning. Restore the
      // shared hook immediately so unrelated concurrent spawns cannot inherit
      // this foreground caller's callback while its run is awaited.
      id = this.spawn(pi, ctx, type, prompt, { ...options, isBackground: false });
    } finally {
      this.onSpawned = prevOnSpawned;
    }
    const record = this.agents.get(id)!;
    await record.promise;
    return { id, record };
  }

  private canResume(record: AgentRecord): boolean {
    return record.status !== "running"
      && record.status !== "queued"
      && record.settledRevision === record.runRevision
      && record.resultConsumed === true
      && record.pendingDeliveryRevision !== record.runRevision;
  }

  private beginResume(record: AgentRecord, status: "queued" | "running"): number {
    record.runRevision += 1;
    record.status = status;
    record.startedAt = Date.now();
    record.completedAt = undefined;
    record.result = undefined;
    record.error = undefined;
    record.promise = undefined;
    record.resultConsumed = false;
    record.stoppingRevision = undefined;
    record.abortController = new AbortController();
    if (record.worktree) record.worktreeRevision = record.runRevision;
    return record.runRevision;
  }

  private async executeResume(
    record: AgentRecord,
    prompt: string,
    revision: number,
    signal?: AbortSignal,
  ): Promise<AgentRecord> {
    const session = record.session!;
    const worktree = record.worktree;
    if (record.outputFile && record.outputCwd) {
      const historyBoundary = session.messages.length;
      const initialWrittenCount = historyBoundary + (record.outputPromptRevision === revision ? 1 : 0);
      record.outputCleanup = streamToOutputFile(
        session,
        record.outputFile,
        record.id,
        record.outputCwd,
        initialWrittenCount,
      );
      record.outputCleanupRevision = revision;
    }

    try {
      const { text, failure } = await resumeAgent(session, prompt, {
        onToolActivity: (activity) => {
          if (record.runRevision === revision) {
            if (activity.type === "end") record.toolUses++;
            this.onActivity?.(record, { type: "tool", activity });
          }
        },
        onTextDelta: (_delta, fullText) => {
          if (record.runRevision === revision) this.onActivity?.(record, { type: "text", fullText });
        },
        onThinkingDelta: (_delta, fullThinking) => {
          if (record.runRevision === revision) this.onActivity?.(record, { type: "thinking", fullText: fullThinking });
        },
        onTurnEnd: (turnCount) => {
          if (record.runRevision === revision) this.onActivity?.(record, { type: "turn", turnCount });
        },
        onAssistantUsage: (usage) => {
          if (record.runRevision === revision) {
            addUsage(record.lifetimeUsage, usage);
            this.onActivity?.(record, { type: "usage", usage });
          }
        },
        onCompaction: (info) => {
          if (record.runRevision !== revision) return;
          record.compactionCount++;
          this.onCompact?.(record, info);
          this.onActivity?.(record, { type: "compaction", info });
        },
        signal,
      });
      if (record.runRevision === revision) {
        if (record.status !== "stopped") {
          record.status = failure ? "error" : "completed";
          if (failure) record.error = failure;
        }
        record.result = text;
        record.completedAt = Date.now();
      }
    } catch (err) {
      if (record.runRevision === revision) {
        if (record.status !== "stopped") {
          record.status = "error";
          record.error = err instanceof Error ? err.message : String(err);
        }
        record.completedAt = Date.now();
      }
    }

    const worktreeResult = await this.settleRevisionArtifacts(record, revision, worktree);
    if (record.runRevision !== revision) return record;

    if (record.worktreeBaseCwd) {
      this.applyWorktreeResult(
        record,
        worktreeResult,
        record.worktreeBaseCwd,
        record.worktreeHasCustomCwd === true,
      );
    }
    return record;
  }

  /** Resume an existing agent session and wait for its next turn. */
  async resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<AgentRecord | undefined> {
    const record = this.agents.get(id);
    if (!record?.session || !this.canResume(record)) return undefined;
    const revision = this.beginResume(record, "running");
    this.onActivity?.(record, { type: "start" });
    const controller = record.abortController!;
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener("abort", forwardAbort, { once: true });

    const execution = this.executeResume(record, prompt, revision, controller.signal);
    const promise = execution.then(resumed => resumed.runRevision === revision ? resumed.result ?? "" : "");
    record.promise = promise;
    const settlement = promise.then(() => {
      if (record.runRevision === revision) record.settledRevision = revision;
    });
    try {
      const resumed = await execution;
      await settlement;
      if (resumed.runRevision !== revision || resumed.settledRevision !== revision) return undefined;
      try { this.onFinish?.(resumed); } catch { /* ignore activity side-effect errors */ }
      resumed.resultConsumed = true;
      return resumed;
    } finally {
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  /** Queue a top-level background resume under the shared concurrency limit. */
  resumeInBackground(id: string, prompt: string): AgentRecord | undefined {
    const record = this.agents.get(id);
    if (!record?.session || record.parentAgentId || !this.canResume(record)) return undefined;

    const revision = this.beginResume(record, "queued");
    // Resume reuses the record, so replace the prior run's identity at dispatch
    // time. Queue start must preserve this value.
    record.parentSessionGeneration = this.captureParentGeneration?.();
    if (this.runningBackground >= this.maxConcurrent) {
      this.queue.push({ kind: "resume", id, prompt, revision });
    } else {
      this.startBackgroundResume(record, prompt, revision);
    }
    return record;
  }

  private startBackgroundResume(record: AgentRecord, prompt: string, revision: number): void {
    if (record.runRevision !== revision || record.status !== "queued") return;
    record.status = "running";
    record.startedAt = Date.now();
    this.runningBackground++;
    this.onStart?.(record);
    this.onActivity?.(record, { type: "start" });

    const execution = this.executeResume(record, prompt, revision, record.abortController?.signal);
    const promise = execution.then(
      resumed => resumed.runRevision === revision ? resumed.result ?? "" : "",
    );
    record.promise = promise;
    void promise.then(() => {
      this.runningBackground--;
      if (record.runRevision === revision) {
        record.settledRevision = revision;
        try { this.onFinish?.(record); } catch { /* ignore activity side-effect errors */ }
        try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
      }
      this.drainQueue();
    });
  }

  /**
   * Send a steering message to an agent from the UI (mirrors the steer_subagent
   * tool). A live session delivers it now — it interrupts the agent after its
   * current tool execution and appears as a user message. If the session isn't
   * ready yet, the message is queued on `pendingSteers` and flushed when the
   * session is created. Returns false if the agent can't accept steering
   * (unknown id, or no longer running/queued).
   */
  steer(id: string, message: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    if (record.status !== "running" && record.status !== "queued") return false;
    if (record.session) {
      record.session.steer(message).catch(() => {});
    } else {
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push(message);
    }
    return true;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // Remove from queue if queued
    if (record.status === "queued") {
      this.queue = this.queue.filter(q => q.id !== id);
      record.stoppingRevision = record.runRevision;
      record.status = "stopped";
      record.completedAt = Date.now();
      record.settledRevision = record.runRevision;
      try { this.onFinish?.(record); } catch { /* ignore activity side-effect errors */ }
      return true;
    }

    if (record.status !== "running") return false;
    record.stoppingRevision = record.runRevision;
    record.abortController?.abort();
    record.status = "stopped";
    record.completedAt = Date.now();
    return true;
  }

  /** Remove eligible nested records before their parents can remove a shared cleanup cwd. */
  private removeRecordsChildFirst(shouldRemove: (record: AgentRecord) => boolean): void {
    const candidates = [...this.agents.entries()]
      .filter(([, record]) => shouldRemove(record))
      .sort(([, a], [, b]) => (b.depth ?? 1) - (a.depth ?? 1));

    for (const [id, record] of candidates) {
      if ([...this.agents.values()].some(child => child.parentAgentId === id)) continue;
      this.removeRecord(id, record);
    }
  }

  /** Dispose a settled record's session, clean retained artifacts, and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    if (record.settledRevision !== record.runRevision) {
      const worktreeNote = record.worktree ? ` Worktree retained at ${record.worktree.path}.` : "";
      console.warn(`[pi-subagents] Agent ${id} is still settling revision ${record.runRevision}; artifacts were retained.${worktreeNote}`);
      return;
    }

    if (record.worktree) {
      if (!record.worktreeBaseCwd) {
        this.applyWorktreeResult(
          record,
          worktreeCheckpointFailure(record.worktree.path, "Worktree base repository is unavailable."),
          "",
          false,
          "cleanup",
        );
        return;
      }
      if (record.worktreeResult?.status === "failed") {
        console.warn(
          `[pi-subagents] Worktree retained at ${record.worktreeResult.path}: ${record.worktreeResult.error}`,
        );
        return;
      }

      let cleanupResult: WorktreeCleanupResult;
      try {
        cleanupResult = cleanupWorktree(record.worktreeBaseCwd, record.worktree, record.description);
      } catch (err) {
        cleanupResult = worktreeCheckpointFailure(record.worktree.path, err);
      }
      if (cleanupResult.status === "failed") {
        this.applyWorktreeResult(
          record,
          cleanupResult,
          record.worktreeBaseCwd,
          record.worktreeHasCustomCwd === true,
          "cleanup",
        );
        return;
      }
      record.worktree = undefined;
    }

    if (record.outputCleanup) {
      try { record.outputCleanup(); } catch { /* ignore transcript flush errors */ }
      record.outputCleanup = undefined;
      record.outputCleanupRevision = undefined;
    }
    record.session?.dispose?.();
    record.session = undefined;
    this.agents.delete(id);
  }

  private cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    this.removeRecordsChildFirst(record =>
      record.status !== "running"
      && record.status !== "queued"
      && record.settledRevision === record.runRevision
      && (record.completedAt ?? 0) < cutoff
    );
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
   * (resultConsumed=false) — they will be evicted by the 10-minute cleanup timer instead.
   */
  clearCompleted(skipUnconsumed = false): void {
    this.removeRecordsChildFirst(record =>
      record.status !== "running"
      && record.status !== "queued"
      && record.settledRevision === record.runRevision
      && (!skipUnconsumed || record.resultConsumed === true)
    );
  }

  /** Whether any agent revision is queued, running, or still settling after stop. */
  hasRunning(): boolean {
    return [...this.agents.values()].some(
      record => record.status === "queued" || record.settledRevision !== record.runRevision,
    );
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    let count = 0;
    // Clear queued agents first
    for (const queued of this.queue) {
      const record = this.agents.get(queued.id);
      if (record) {
        record.stoppingRevision = record.runRevision;
        record.status = "stopped";
        record.completedAt = Date.now();
        record.settledRevision = record.runRevision;
        try { this.onFinish?.(record); } catch { /* ignore activity side-effect errors */ }
        count++;
      }
    }
    this.queue = [];
    // Abort running agents
    for (const record of this.agents.values()) {
      if (record.status === "running") {
        record.stoppingRevision = record.runRevision;
        record.abortController?.abort();
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    return count;
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  async waitForAll(): Promise<void> {
    // Loop because drainQueue respects the concurrency limit — as running
    // agents finish they start queued ones, which need awaiting too.
    while (true) {
      this.drainQueue();
      const pending = [...this.agents.values()]
        .filter(record => record.status === "queued" || record.settledRevision !== record.runRevision)
        .map(record => record.promise)
        .filter(Boolean);
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  dispose() {
    clearInterval(this.cleanupInterval);
    this.abortAll();
    this.removeRecordsChildFirst(() => true);
    // Prune any orphaned git worktrees (crash recovery)
    try { pruneWorktrees(process.cwd()); } catch { /* ignore */ }
    // Also prune repos that caller-supplied cwds created worktrees in — a clean
    // exit with in-flight agents would otherwise leave stale registrations there.
    for (const repo of this.worktreeRepos) {
      try { pruneWorktrees(repo); } catch { /* ignore */ }
    }
  }
}
