/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebMcpContext } from './tools';
import * as componentTools from './componentTools';
import * as projectTools from './projectTools';
import { executeInternalWebMcpTool } from './internalTools';

interface ModelContextTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
  execute: (input: Record<string, unknown>) => Promise<string> | string;
}

interface ModelContext {
  registerTool(tool: ModelContextTool, options?: { signal?: AbortSignal }): Promise<void>;
  getTools?(): Promise<unknown[]>;
}

export interface WebMcpSessionState {
  status: 'unsupported' | 'ready' | 'active';
  lastTool: string | null;
  lastTransactionId: string | null;
  calls: number;
}

export interface WebMcpSession {
  getState(): WebMcpSessionState;
  subscribe(listener: (state: WebMcpSessionState) => void): () => void;
}

interface MutableWebMcpSession extends WebMcpSession {
  record(tool: string, transactionId?: string | null): void;
}

function createSession(available: boolean): MutableWebMcpSession {
  let state: WebMcpSessionState = {
    status: available ? 'ready' : 'unsupported',
    lastTool: null,
    lastTransactionId: null,
    calls: 0,
  };
  const listeners = new Set<(next: WebMcpSessionState) => void>();
  return {
    getState: () => ({ ...state }),
    subscribe(listener) {
      listeners.add(listener);
      listener({ ...state });
      return () => listeners.delete(listener);
    },
    record(tool, transactionId = null) {
      state = {
        status: 'active',
        lastTool: tool,
        lastTransactionId: transactionId ?? state.lastTransactionId,
        calls: state.calls + 1,
      };
      for (const listener of listeners) listener({ ...state });
    },
  };
}

declare global {
  interface Document {
    modelContext?: ModelContext;
  }
  interface Navigator {
    modelContext?: ModelContext;
  }
}

function getModelContext(): ModelContext | null {
  if (document.modelContext?.registerTool) return document.modelContext;
  if (navigator.modelContext?.registerTool) return navigator.modelContext;
  return null;
}

function jsonSchema(props: Record<string, unknown>, required: string[] = []) {
  return {
    type: 'object',
    properties: props,
    required,
    additionalProperties: false,
  };
}

import type { ToolResult } from '../../core/types';
import { WEBMCP_TOOL_VERSION } from './semanticTools';

async function runWithContext(
  ctx: WebMcpContext,
  fn: () => ToolResult | Promise<ToolResult>,
) {
  const result = await fn();
  return JSON.stringify({
    toolVersion: WEBMCP_TOOL_VERSION,
    schemaVersion: ctx.bus.project.schemaVersion,
    revision: ctx.bus.getRevision(),
    ...(result.ok ? {} : { code: result.code ?? 'TOOL_FAILED' }),
    warnings: [],
    ...result,
  });
}

function recordingMessage(role: 'direction' | 'action', text: unknown, detail?: string): void {
  if (typeof text !== 'string' || !text.trim()) return;
  document.dispatchEvent(new CustomEvent('horizon:recording-message', {
    detail: { role, text: text.trim(), detail },
  }));
}

export function registerHorizonWebMcpTools(ctx: WebMcpContext): {
  available: boolean;
  count: number;
  unregister: () => void;
  session: WebMcpSession;
} {
  const mc = getModelContext();
  const session = createSession(Boolean(mc?.registerTool));
  if (!mc?.registerTool) {
    return { available: false, count: 0, unregister: () => {}, session };
  }

  const controller = new AbortController();
  const run = (fn: () => ToolResult | Promise<ToolResult>) => runWithContext(ctx, fn);
  const defs: ModelContextTool[] = [
    {
      name: 'about',
      title: 'About Horizon Studio — Call First',
      description:
        'Call this first. Explains Horizon Studio, current capabilities and permissions, every public tool, component conventions, validation, and multi-call task workflows.',
      annotations: { readOnlyHint: true },
      execute: () => run(() => componentTools.about(ctx)),
    },
    {
      name: 'newProject',
      title: 'New Project',
      description: 'Creates and opens a genuinely blank Horizon project, or a new project from a built-in template.',
      inputSchema: jsonSchema({
        name: { type: 'string' },
        templateId: { type: 'string' },
        expectedRevision: { type: 'integer', minimum: 0 },
      }, ['expectedRevision']),
      execute: (input) => run(() => projectTools.newProject(ctx, input as never)),
    },
    {
      name: 'listProjects',
      title: 'List Projects',
      description: 'Lists projects saved in this browser without opening or changing them.',
      annotations: { readOnlyHint: true },
      execute: () => run(() => projectTools.listProjects(ctx)),
    },
    {
      name: 'openProject',
      title: 'Open Project',
      description: 'Opens a project saved in this browser by project ID.',
      inputSchema: jsonSchema({
        projectId: { type: 'string' },
        expectedRevision: { type: 'integer', minimum: 0 },
      }, ['projectId', 'expectedRevision']),
      execute: (input) => run(() => projectTools.openProject(ctx, input as never)),
    },
    {
      name: 'editProject',
      title: 'Edit Project',
      description: 'Applies a validated batch of cross-entity project edits as one revision-checked, undoable transaction. Created entities may be referenced later in the same batch with @clientRef.',
      inputSchema: jsonSchema({
        operations: {
          type: 'array',
          minItems: 1,
          maxItems: 2000,
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                enum: ['setProject', 'setMetadata', 'setPresentation', 'setPublicContract', 'patchEntity', 'moveNode', 'createAsset', 'createNode', 'createShader', 'createMaterial', 'createComposition', 'createSequence', 'createTrack', 'addClip', 'addMarker', 'addBehavior', 'setProperty'],
              },
              ref: { type: 'string' },
              id: { type: 'string' },
            },
            required: ['op'],
            additionalProperties: true,
          },
        },
        expectedRevision: { type: 'integer', minimum: 0 },
        intent: { type: 'string' },
      }, ['operations', 'expectedRevision']),
      execute: (input) => run(() => projectTools.executePublicProjectTool(ctx, 'editProject', input)),
    },
    {
      name: 'importProject',
      title: 'Import Horizon Project',
      description: 'Imports and opens a .hzn package from an inline data URL or an allowed URL.',
      inputSchema: jsonSchema({
        dataUrl: { type: 'string' },
        url: { type: 'string' },
        expectedRevision: { type: 'integer', minimum: 0 },
      }, ['expectedRevision']),
      execute: (input) => run(() => projectTools.importProject(ctx, input as never)),
    },
    {
      name: 'saveProject',
      title: 'Save Project',
      description: 'Saves the current project to durable browser storage.',
      inputSchema: jsonSchema({ expectedRevision: { type: 'integer', minimum: 0 } }, ['expectedRevision']),
      execute: (input) => run(() => projectTools.saveProject(ctx, input as never)),
    },
    {
      name: 'exportProject',
      title: 'Export Horizon Project',
      description: 'Downloads the current editable project as a portable .hzn package.',
      inputSchema: jsonSchema({ expectedRevision: { type: 'integer', minimum: 0 } }, ['expectedRevision']),
      execute: (input) => run(() => projectTools.exportProject(ctx, input as never)),
    },
    {
      name: 'publishProject',
      title: 'Publish Project',
      description: 'Builds and downloads the current project as a serverless static web runtime.',
      inputSchema: jsonSchema({ expectedRevision: { type: 'integer', minimum: 0 } }, ['expectedRevision']),
      execute: (input) => run(() => projectTools.publishProject(ctx, input as never)),
    },
    {
      name: 'previewProject',
      title: 'Preview Project',
      description: 'Opens the current project runtime in a separate browser tab, optionally at a sequence.',
      inputSchema: jsonSchema({ sequenceId: { type: 'string' } }),
      execute: (input) => run(() => projectTools.previewProject(ctx, input as never)),
    },
    {
      name: 'listComponents',
      title: 'List Components',
      description:
        'Lists discoverable project/editor components with full metadata, pagination, and embedded capabilities/policy metadata.',
      inputSchema: jsonSchema({
        query: { type: 'string' },
        kind: { type: 'string' },
        componentType: { type: 'string' },
        ownerId: { type: 'string' },
        registryScope: { type: 'string' },
        mutable: { type: 'boolean' },
        offset: { type: 'integer', minimum: 0 },
        cursor: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      }),
      annotations: { readOnlyHint: true },
      execute: (input) => run(() => componentTools.listComponents(ctx, input)),
    },
    {
      name: 'findComponents',
      title: 'Find Components',
      description:
        'Finds components by query and filters; returns full descriptor metadata with pagination.',
      inputSchema: jsonSchema({
        query: { type: 'string' },
        kind: { type: 'string' },
        componentType: { type: 'string' },
        ownerId: { type: 'string' },
        registryScope: { type: 'string' },
        mutable: { type: 'boolean' },
        animatable: { type: 'boolean' },
        offset: { type: 'integer', minimum: 0 },
        cursor: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      }),
      annotations: { readOnlyHint: true },
      execute: (input) => run(() => componentTools.findComponents(ctx, input)),
    },
    {
      name: 'inspectComponent',
      title: 'Inspect Component',
      description:
        'Returns one component with help, dataType, componentType, currentValue, rangeMin, rangeMax, validationFunction, and validationRules.',
      inputSchema: jsonSchema({
        componentId: { type: 'string' },
        value: {
          description: 'Optional parameters for live inspection actions.',
          type: 'object',
        },
      }, ['componentId']),
      annotations: { readOnlyHint: true },
      execute: (input) =>
        run(() => componentTools.inspectComponent(ctx, input as { componentId: string; value?: unknown })),
    },
    {
      name: 'selectedComponent',
      title: 'Selected Components',
      description: 'Returns rich selected component descriptors for the current editor selection.',
      annotations: { readOnlyHint: true },
      execute: () => run(() => componentTools.selectedComponent(ctx)),
    },
    {
      name: 'selectComponent',
      title: 'Select Components',
      description: 'Updates editor selection using replace, add, remove, or clear mode.',
      inputSchema: jsonSchema({
        componentIds: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['replace', 'add', 'remove', 'clear'] },
      }),
      execute: (input) => run(() => componentTools.selectComponent(ctx, input as never)),
    },
    {
      name: 'updateComponent',
      title: 'Update Component',
      description:
        'Creates, appends, upserts, or updates a component through CommandBus with validation, revision checks, attribution, and undo support.',
      inputSchema: jsonSchema({
        componentId: { type: 'string' },
        operation: { type: 'string', enum: ['create', 'append', 'upsert', 'update', 'invoke'] },
        value: {},
        properties: { type: 'object' },
        patch: { type: 'object' },
        expectedRevision: { type: 'integer', minimum: 0 },
        intent: { type: 'string' },
      }, ['componentId']),
      execute: (input) => run(() => componentTools.updateComponent(ctx, input as never)),
    },
    {
      name: 'removeComponent',
      title: 'Remove Component',
      description:
        'Removes safely deletable entities with permission and revision policy through CommandBus.',
      inputSchema: jsonSchema({
        componentId: { type: 'string' },
        expectedRevision: { type: 'integer', minimum: 0 },
        intent: { type: 'string' },
      }, ['componentId']),
      execute: (input) => run(() => componentTools.removeComponent(ctx, input as never)),
    },
  ];

  for (const def of defs) {
    try {
      const execute = def.execute;
      const monitored: ModelContextTool = {
        ...def,
        execute: async (input) => {
          recordingMessage('direction', input.intent);
          const output = await execute(input);
          let transactionId: string | null = null;
          try {
            const parsed = JSON.parse(output) as { transactionId?: string; summary?: string; ok?: boolean };
            transactionId = parsed.transactionId ?? null;
            recordingMessage('action', parsed.summary, parsed.ok === false ? 'Could not complete the change' : undefined);
          } catch { /* valid tool errors remain observable */ }
          session.record(def.name, transactionId);
          return output;
        },
      };
      void Promise.resolve(mc.registerTool(monitored, { signal: controller.signal })).catch(() => {});
    } catch {
      // A single unsupported tool must not prevent manual Studio use.
    }
  }

  return {
    available: true,
    count: defs.length,
    unregister: () => controller.abort(),
    session,
  };
}

export function isWebMcpAvailable(): boolean {
  return Boolean(
    document.modelContext?.registerTool ?? navigator.modelContext?.registerTool,
  );
}

export function exposeWebMcpDebug(ctx: WebMcpContext) {
  const run = (fn: () => ToolResult | Promise<ToolResult>) => runWithContext(ctx, fn);
  (window as unknown as { horizonWebMcp: unknown }).horizonWebMcp = {
    isAvailable: isWebMcpAvailable,
    publicTools: componentTools.PUBLIC_WEBMCP_TOOL_NAMES,
    execute: async (name: string, input: Record<string, unknown> = {}) => {
      const publicName = componentTools.resolvePublicToolName(name);
      if (publicName) return run(() => componentTools.executePublicComponentTool(ctx, publicName, input));
      return run(() => executeInternalWebMcpTool(ctx, name, input));
    },
  };
}
