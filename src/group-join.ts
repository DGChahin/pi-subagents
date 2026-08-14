/**
 * group-join.ts — Manages grouped background agent completion notifications.
 *
 * Instead of each agent individually nudging the main agent on completion,
 * agents in a group are held until all complete (or a timeout fires),
 * then a single consolidated notification is sent.
 */

import type { AgentRecord } from "./types.js";

export interface AgentRunCompletion {
  readonly record: AgentRecord;
  readonly revision: number;
}

export type DeliveryCallback = (completions: readonly AgentRunCompletion[], partial: boolean) => void;

interface AgentGroup {
  groupId: string;
  agentRevisions: Map<string, number>;
  completedRuns: Map<string, AgentRunCompletion>;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  delivered: boolean;
  /** Shorter timeout for stragglers after a partial delivery. */
  isStraggler: boolean;
}

/** Default timeout: 30s after first completion in a group. */
const DEFAULT_TIMEOUT = 30_000;
/** Straggler re-batch timeout: 15s. */
const STRAGGLER_TIMEOUT = 15_000;

export class GroupJoinManager {
  private groups = new Map<string, AgentGroup>();
  private agentToGroup = new Map<string, string>();

  constructor(
    private deliverCb: DeliveryCallback,
    private groupTimeout = DEFAULT_TIMEOUT,
  ) {}

  /** Register specific agent runs that should be joined. */
  registerGroup(groupId: string, completions: readonly AgentRunCompletion[]): void {
    if (completions.length === 0) return;
    const group: AgentGroup = {
      groupId,
      agentRevisions: new Map(completions.map(({ record, revision }) => [record.id, revision])),
      completedRuns: new Map(),
      delivered: false,
      isStraggler: false,
    };
    this.groups.set(groupId, group);
    for (const { record } of completions) {
      this.agentToGroup.set(record.id, groupId);
    }
  }

  /**
   * Called when an agent completes.
   * Returns:
   * - 'pass'      — agent is not grouped, caller should send individual nudge
   * - 'held'      — result held, waiting for group completion
   * - 'delivered'  — this completion triggered the group notification
   */
  onAgentComplete(completion: AgentRunCompletion): 'delivered' | 'held' | 'pass' {
    const { record, revision } = completion;
    const groupId = this.agentToGroup.get(record.id);
    if (!groupId) return 'pass';

    const group = this.groups.get(groupId);
    if (
      !group
      || group.delivered
      || group.agentRevisions.get(record.id) !== revision
      || record.runRevision !== revision
      || record.pendingDeliveryRevision !== revision
      || record.resultConsumed === true
    ) return 'pass';

    group.completedRuns.set(record.id, completion);

    // All done — deliver immediately
    if (group.completedRuns.size >= group.agentRevisions.size) {
      this.deliver(group, false);
      return 'delivered';
    }

    // First completion in this batch — start timeout
    if (!group.timeoutHandle) {
      const timeout = group.isStraggler ? STRAGGLER_TIMEOUT : this.groupTimeout;
      group.timeoutHandle = setTimeout(() => {
        this.onTimeout(group);
      }, timeout);
    }

    return 'held';
  }

  private onTimeout(group: AgentGroup): void {
    if (group.delivered) return;
    group.timeoutHandle = undefined;

    // Partial delivery — some agents still running
    const remaining = new Map<string, number>();
    for (const [id, revision] of group.agentRevisions) {
      if (!group.completedRuns.has(id)) remaining.set(id, revision);
    }

    // Clean up agentToGroup for delivered agents (they won't complete again)
    for (const id of group.completedRuns.keys()) {
      this.agentToGroup.delete(id);
    }

    // Deliver what we have
    const completed = [...group.completedRuns.values()].filter(
      ({ record, revision }) => record.runRevision === revision
        && record.pendingDeliveryRevision === revision
        && record.resultConsumed !== true,
    );
    if (completed.length > 0) this.deliverCb(completed, true);

    // Set up straggler group for remaining agents
    group.completedRuns.clear();
    group.agentRevisions = remaining;
    group.isStraggler = true;
    if (remaining.size === 0) this.cleanupGroup(group.groupId);
    // Timeout will be started when the next straggler completes
  }

  private deliver(group: AgentGroup, partial: boolean): void {
    if (group.timeoutHandle) {
      clearTimeout(group.timeoutHandle);
      group.timeoutHandle = undefined;
    }
    group.delivered = true;
    const completed = [...group.completedRuns.values()].filter(
      ({ record, revision }) => record.runRevision === revision
        && record.pendingDeliveryRevision === revision
        && record.resultConsumed !== true,
    );
    if (completed.length > 0) this.deliverCb(completed, partial);
    this.cleanupGroup(group.groupId);
  }

  private cleanupGroup(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    if (group.timeoutHandle) clearTimeout(group.timeoutHandle);
    for (const id of group.agentRevisions.keys()) {
      this.agentToGroup.delete(id);
    }
    this.groups.delete(groupId);
  }

  /** Remove one consumed run without affecting a later run with the same ID. */
  consume(agentId: string, revision: number): boolean {
    const groupId = this.agentToGroup.get(agentId);
    if (!groupId) return false;
    const group = this.groups.get(groupId);
    if (!group || group.agentRevisions.get(agentId) !== revision) return false;

    group.agentRevisions.delete(agentId);
    group.completedRuns.delete(agentId);
    this.agentToGroup.delete(agentId);
    if (group.agentRevisions.size === 0) {
      this.cleanupGroup(groupId);
    } else if (group.completedRuns.size >= group.agentRevisions.size) {
      this.deliver(group, false);
    }
    return true;
  }

  /** Cancel every group and return the completed runs that were held. */
  cancelPending(): readonly AgentRunCompletion[] {
    const pending = [...this.groups.values()].flatMap(group => [...group.completedRuns.values()]);
    for (const group of this.groups.values()) {
      if (group.timeoutHandle) clearTimeout(group.timeoutHandle);
    }
    this.groups.clear();
    this.agentToGroup.clear();
    return pending;
  }

  /** Check if an agent is in a group. */
  isGrouped(agentId: string): boolean {
    return this.agentToGroup.has(agentId);
  }

  dispose(): void {
    this.cancelPending();
  }
}
