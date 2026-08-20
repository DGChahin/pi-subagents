/**
 * worktree.ts — Git worktree isolation for agents.
 *
 * Creates a temporary git worktree so the agent works on an isolated copy of the repo.
 * Turn completion checkpoints changes to a branch while the resumable worktree stays live.
 * Definitive record cleanup removes the worktree and preserves its result branch.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

export interface WorktreeInfo {
  /** Absolute path to the worktree directory (the copied repo's root). */
  path: string;
  /** Branch name created for this worktree (if changes exist). */
  branch: string;
  /** Whether this worktree has created and now owns `branch`. */
  branchCreated?: boolean;
  /** Commit SHA that the worktree was created from. */
  baseSha: string;
  /**
   * Where the agent should work inside the worktree: the equivalent of the
   * cwd the worktree was created from. Equals `path` when that cwd was the
   * repo root; points at the copied subdirectory when it was deeper (e.g. a
   * monorepo package), so the requested scoping survives isolation.
   */
  workPath: string;
}

/**
 * Project-wide switch for worktree isolation (`worktreeIsolation` in
 * subagents.json). Default `true` — unchanged behaviour.
 *
 * The `"off"` isolation value gives a model a legal way to decline a worktree,
 * but it still depends on the model choosing it. This is the deterministic half
 * of the same fix: on a large repo where every worktree costs real time and
 * disk (#184), turning it off means no caller can create one, whatever it
 * passes.
 */
let worktreeIsolationEnabled = true;

export function setWorktreeIsolationEnabled(enabled: boolean): void {
  worktreeIsolationEnabled = enabled;
}

export function isWorktreeIsolationEnabled(): boolean {
  return worktreeIsolationEnabled;
}

export type WorktreeCleanupResult =
  | {
    status: "unchanged";
    hasChanges: false;
    branch?: never;
    path?: never;
    error?: never;
  }
  | {
    status: "checkpointed";
    hasChanges: true;
    branch: string;
    path: string;
    error?: never;
  }
  | {
    status: "failed";
    hasChanges?: never;
    branch?: never;
    path: string;
    error: string;
  };

/**
 * Create a temporary git worktree for an agent.
 * Returns the worktree path, or undefined if not in a git repo.
 */
export function createWorktree(cwd: string, agentId: string): WorktreeInfo | undefined {
  // Verify we're in a git repo with at least one commit (HEAD must exist)
  let baseSha: string;
  let subdir: string;
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "pipe", timeout: 5000 });
    baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: "pipe", timeout: 5000 })
      .toString()
      .trim();
    // Where cwd sits inside the repo ("" at the root): the agent must work at
    // the same subdirectory inside the copy, or a monorepo-package cwd would
    // silently widen to the whole repo. realpath both sides — git emits
    // resolved paths while cwd may arrive through a symlink (macOS /tmp).
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: "pipe", timeout: 5000 })
      .toString()
      .trim();
    subdir = relative(realpathSync(topLevel), realpathSync(cwd));
  } catch {
    return undefined;
  }

  const branch = `pi-agent-${agentId}`;
  const suffix = randomUUID().slice(0, 8);
  const worktreePath = join(tmpdir(), `pi-agent-${agentId}-${suffix}`);

  try {
    // Create detached worktree at HEAD
    execFileSync("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], {
      cwd,
      stdio: "pipe",
      timeout: 30000,
    });
    return { path: worktreePath, branch, baseSha, workPath: subdir ? join(worktreePath, subdir) : worktreePath };
  } catch {
    // If worktree creation fails, return undefined (agent runs in normal cwd)
    return undefined;
  }
}

/** Commit current work and update its result branch without removing the resumable worktree. */
export function checkpointWorktree(
  worktree: WorktreeInfo,
  agentDescription: string,
): WorktreeCleanupResult {
  if (!existsSync(worktree.path)) {
    return {
      status: "failed",
      path: worktree.path,
      error: "Worktree path does not exist.",
    };
  }

  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: worktree.path,
      stdio: "pipe",
      timeout: 10000,
    }).toString().trim();

    if (status) {
      execFileSync("git", ["add", "-A"], { cwd: worktree.path, stdio: "pipe", timeout: 10000 });
      const safeDesc = agentDescription.slice(0, 200);
      execFileSync("git", ["commit", "--no-verify", "-m", `pi-agent: ${safeDesc}`], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 10000,
      });
    }

    const currentSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: worktree.path,
      stdio: "pipe",
      timeout: 5000,
    }).toString().trim();
    if (currentSha === worktree.baseSha) {
      return { status: "unchanged", hasChanges: false };
    }

    if (!worktree.branchCreated) {
      let branchName = worktree.branch;
      try {
        execFileSync("git", ["switch", "-c", branchName], {
          cwd: worktree.path,
          stdio: "pipe",
          timeout: 5000,
        });
      } catch {
        branchName = `${worktree.branch}-${Date.now()}`;
        execFileSync("git", ["switch", "-c", branchName], {
          cwd: worktree.path,
          stdio: "pipe",
          timeout: 5000,
        });
      }
      worktree.branch = branchName;
      worktree.branchCreated = true;
    }

    return {
      status: "checkpointed",
      hasChanges: true,
      branch: worktree.branch,
      path: worktree.path,
    };
  } catch (err) {
    return {
      status: "failed",
      path: worktree.path,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Save final changes, remove the retained worktree, and keep its result branch. */
export function cleanupWorktree(
  cwd: string,
  worktree: WorktreeInfo,
  agentDescription: string,
): WorktreeCleanupResult {
  const result = checkpointWorktree(worktree, agentDescription);
  if (result.status === "failed") return result;

  const removalError = removeWorktree(cwd, worktree.path);
  if (removalError) {
    return {
      status: "failed",
      path: worktree.path,
      error: `Worktree removal failed: ${removalError}`,
    };
  }
  return result;
}

/** Force-remove a worktree, returning an error when recovery remains necessary. */
function removeWorktree(cwd: string, worktreePath: string): string | undefined {
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd,
      stdio: "pipe",
      timeout: 10000,
    });
    return undefined;
  } catch (err) {
    // Pruning can clear a stale registration, but it does not make the failed
    // removal successful or prove that the retained path is safe to forget.
    try {
      execFileSync("git", ["worktree", "prune"], { cwd, stdio: "pipe", timeout: 5000 });
    } catch { /* retain the original removal error */ }
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Prune any orphaned worktrees (crash recovery).
 */
export function pruneWorktrees(cwd: string): void {
  try {
    execFileSync("git", ["worktree", "prune"], { cwd, stdio: "pipe", timeout: 5000 });
  } catch { /* ignore */ }
}
