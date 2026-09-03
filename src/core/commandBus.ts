/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Author, Command, HistoryEntry, HorizonProject, Transaction } from './types';
import { createId, nowIso } from './ids';
import { applyCommand, invertCommand } from './commands';

export type ProjectListener = (project: HorizonProject, changed: string[]) => void;
export type HistoryListener = (entries: HistoryEntry[]) => void;

export interface TransactionResult {
  ok: true;
  transactionId: string;
  changed: string[];
  warnings: string[];
}

export interface TransactionFailure {
  ok: false;
  error: string;
  warnings?: string[];
}

export class CommandBus {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private projectListeners = new Set<ProjectListener>();
  private historyListeners = new Set<HistoryListener>();
  private maxHistory = 200;
  private revision = 0;

  constructor(public project: HorizonProject) {}

  /** Monotonic live-state revision used by optimistic semantic adapters. */
  getRevision(): number {
    return this.revision;
  }

  subscribe(listener: ProjectListener): () => void {
    this.projectListeners.add(listener);
    return () => this.projectListeners.delete(listener);
  }

  subscribeHistory(listener: HistoryListener): () => void {
    this.historyListeners.add(listener);
    return () => this.historyListeners.delete(listener);
  }

  private notify(changed: string[]): void {
    for (const l of this.projectListeners) l(this.project, changed);
    for (const l of this.historyListeners) l(this.undoStack);
  }

  /** Notify subscribers without recording history (used for ephemeral preview state). */
  emitChange(changed: string[] = []): void {
    this.notify(changed);
  }

  executeTransaction(
    commands: Command[],
    author: Author,
    intent: string,
    source?: string,
  ): TransactionResult | TransactionFailure {
    const txId = createId('transaction');
    const snapshot = structuredClone(this.project);
    const prepared: Command[] = [];
    const changed = new Set<string>();
    const warnings: string[] = [];

    try {
      for (const cmd of commands) {
        const fullCmd = { ...cmd, transactionId: txId, author, intent, source };
        applyCommand(this.project, fullCmd);
        prepared.push(fullCmd);
        this.collectChanged(fullCmd, changed);
      }
    } catch (e) {
      this.project = snapshot;
      return { ok: false, error: e instanceof Error ? e.message : String(e), warnings };
    }

    const inverseCommands = prepared
      .slice()
      .reverse()
      .map((c) => invertCommand(snapshot, c));

    const transaction: Transaction = {
      id: txId,
      author,
      intent,
      timestamp: nowIso(),
      commands: prepared,
      source,
    };

    this.undoStack.push({ transaction, inverseCommands });
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    this.redoStack = [];
    this.revision++;
    this.notify([...changed]);
    return { ok: true, transactionId: txId, changed: [...changed], warnings };
  }

  private collectChanged(cmd: Command, changed: Set<string>): void {
    const p = cmd.payload;
    if (p.ownerId) changed.add(p.ownerId as string);
    if (p.nodeId) changed.add(p.nodeId as string);
    if (p.compositionId) changed.add(p.compositionId as string);
    if (p.entity) changed.add((p.entity as { id: string }).id);
    if (p.trackId) changed.add(p.trackId as string);
    if (p.materialId) changed.add(p.materialId as string);
    if (p.presetId) changed.add(p.presetId as string);
    if (p.profileId) changed.add(p.profileId as string);
    if (p.aovId) changed.add(p.aovId as string);
    if (p.jobId) changed.add(p.jobId as string);
    if (p.sequenceId) changed.add(p.sequenceId as string);
    if (Array.isArray(p.changedIds)) {
      for (const id of p.changedIds as string[]) changed.add(id);
    }
    if (p.items) {
      for (const item of p.items as Array<{ ownerId: string }>) changed.add(item.ownerId);
    }
    if (
      cmd.type === 'SetRenderProperty' ||
      cmd.type.startsWith('SetRenderPreset') ||
      cmd.type.startsWith('SetQualityProfile') ||
      cmd.type === 'AddAov' ||
      cmd.type === 'RemoveAov' ||
      cmd.type === 'SetAovProperty'
    ) {
      changed.add('__render__');
    }
    if (cmd.type === 'SetEnvironmentProperty') changed.add('__environment__');
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    const snapshot = structuredClone(this.project);
    try {
      for (const cmd of entry.inverseCommands) {
        applyCommand(this.project, { ...cmd, transactionId: createId('transaction') });
      }
    } catch {
      this.project = snapshot;
      this.undoStack.push(entry);
      return false;
    }
    this.redoStack.push(entry);
    this.revision++;
    this.notify([]);
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    try {
      for (const cmd of entry.transaction.commands) {
        applyCommand(this.project, cmd);
      }
    } catch {
      this.redoStack.push(entry);
      return false;
    }
    this.undoStack.push(entry);
    this.revision++;
    this.notify([]);
    return true;
  }

  getRecentHistory(limit = 20) {
    return this.undoStack.slice(-limit).map((e) => this.summarizeHistoryEntry(e));
  }

  getHistoryState() {
    const undoCandidate = this.undoStack.at(-1);
    const redoCandidate = this.redoStack.at(-1);
    return {
      canUndo: Boolean(undoCandidate),
      canRedo: Boolean(redoCandidate),
      undoCandidate: undoCandidate ? this.summarizeHistoryEntry(undoCandidate) : null,
      redoCandidate: redoCandidate ? this.summarizeHistoryEntry(redoCandidate) : null,
    };
  }

  private summarizeHistoryEntry(e: HistoryEntry) {
    return {
      id: e.transaction.id,
      author: e.transaction.author,
      intent: e.transaction.intent,
      timestamp: e.transaction.timestamp,
      source: e.transaction.source,
      commandCount: e.transaction.commands.length,
    };
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  replaceProject(project: HorizonProject): void {
    this.project = project;
    this.undoStack = [];
    this.redoStack = [];
    this.revision++;
    this.notify([]);
  }
}
