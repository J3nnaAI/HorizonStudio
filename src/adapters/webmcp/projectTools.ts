/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolResult } from '../../core/types';
import type { WebMcpContext, WebMcpPermissions } from './tools';
import { WEBMCP_TOOL_VERSION } from './semanticTools';
import { editProject } from './projectEdit';

export const PUBLIC_PROJECT_TOOL_NAMES = [
  'newProject',
  'listProjects',
  'openProject',
  'editProject',
  'importProject',
  'saveProject',
  'exportProject',
  'publishProject',
  'previewProject',
] as const;

export type PublicProjectToolName = typeof PUBLIC_PROJECT_TOOL_NAMES[number];

type RevisionInput = { expectedRevision?: number };

function policy(ctx: WebMcpContext): Required<WebMcpPermissions> {
  return {
    delete: false,
    import: false,
    remoteImport: false,
    save: false,
    export: false,
    publish: false,
    trustedShaderSource: false,
    ...ctx.permissions,
  };
}

function result(ctx: WebMcpContext, value: ToolResult): ToolResult {
  return {
    toolVersion: WEBMCP_TOOL_VERSION,
    schemaVersion: ctx.bus.project.schemaVersion,
    revision: ctx.bus.getRevision(),
    warnings: [],
    ...value,
  };
}

function fail(ctx: WebMcpContext, code: string, error: string): ToolResult {
  return result(ctx, { ok: false, code, error, summary: error });
}

function stale(ctx: WebMcpContext, input: RevisionInput): ToolResult | null {
  if (input.expectedRevision === undefined) {
    return fail(ctx, 'REVISION_REQUIRED', 'expectedRevision is required');
  }
  if (input.expectedRevision !== ctx.bus.getRevision()) {
    return fail(ctx, 'STALE_REVISION', `Expected revision ${input.expectedRevision}, current revision is ${ctx.bus.getRevision()}`);
  }
  return null;
}

async function call(
  ctx: WebMcpContext,
  action: (() => Promise<unknown> | unknown) | undefined,
  unavailable: string,
  summary: string,
): Promise<ToolResult> {
  if (!action) return fail(ctx, 'UNAVAILABLE', unavailable);
  try {
    const data = await action();
    return result(ctx, { ok: true, summary, data });
  } catch (error) {
    return fail(ctx, 'ACTION_FAILED', error instanceof Error ? error.message : String(error));
  }
}

export function listProjects(ctx: WebMcpContext): Promise<ToolResult> {
  return call(ctx, ctx.listProjects, 'Browser project storage is unavailable', 'Listed saved projects');
}

export function newProject(
  ctx: WebMcpContext,
  input: RevisionInput & { name?: string; templateId?: string },
): Promise<ToolResult> {
  const revisionFailure = stale(ctx, input);
  if (revisionFailure) return Promise.resolve(revisionFailure);
  return call(
    ctx,
    ctx.newProject ? () => ctx.newProject!({ name: input.name, templateId: input.templateId }) : undefined,
    'Creating projects is unavailable',
    input.templateId ? `Created project from template ${input.templateId}` : 'Created blank project',
  );
}

export function openProject(
  ctx: WebMcpContext,
  input: RevisionInput & { projectId?: string },
): Promise<ToolResult> {
  const revisionFailure = stale(ctx, input);
  if (revisionFailure) return Promise.resolve(revisionFailure);
  if (!input.projectId?.trim()) return Promise.resolve(fail(ctx, 'INVALID_INPUT', 'projectId is required'));
  return call(
    ctx,
    ctx.openProject ? () => ctx.openProject!(input.projectId!) : undefined,
    'Opening saved projects is unavailable',
    `Opened project ${input.projectId}`,
  );
}

export function importProject(
  ctx: WebMcpContext,
  input: RevisionInput & { dataUrl?: string; url?: string },
): Promise<ToolResult> {
  const revisionFailure = stale(ctx, input);
  if (revisionFailure) return Promise.resolve(revisionFailure);
  const permissions = policy(ctx);
  if (!permissions.import) return Promise.resolve(fail(ctx, 'PERMISSION_DENIED', 'Project import is disabled'));
  if (Boolean(input.dataUrl) === Boolean(input.url)) {
    return Promise.resolve(fail(ctx, 'INVALID_INPUT', 'Supply exactly one of dataUrl or url'));
  }
  if (input.dataUrl && (!input.dataUrl.startsWith('data:') || input.dataUrl.length > 70_000_000)) {
    return Promise.resolve(fail(ctx, 'VALIDATION_FAILED', 'Project data must be a data URL no larger than 50 MB'));
  }
  if (input.url) {
    let parsed: URL;
    try {
      parsed = new URL(input.url, document.baseURI);
    } catch {
      return Promise.resolve(fail(ctx, 'VALIDATION_FAILED', 'Project URL is invalid'));
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return Promise.resolve(fail(ctx, 'VALIDATION_FAILED', 'Project URL must use HTTP or HTTPS'));
    }
    if (parsed.origin !== location.origin && !permissions.remoteImport) {
      return Promise.resolve(fail(ctx, 'PERMISSION_DENIED', 'Cross-origin project import is disabled'));
    }
  }
  return call(
    ctx,
    ctx.importProject ? () => ctx.importProject!({ dataUrl: input.dataUrl, url: input.url }) : undefined,
    'Project import is unavailable',
    'Imported project',
  );
}

export function saveProject(ctx: WebMcpContext, input: RevisionInput): Promise<ToolResult> {
  const revisionFailure = stale(ctx, input);
  if (revisionFailure) return Promise.resolve(revisionFailure);
  if (!policy(ctx).save) return Promise.resolve(fail(ctx, 'PERMISSION_DENIED', 'Project save is disabled'));
  return call(ctx, ctx.saveProject, 'Project save is unavailable', 'Saved project');
}

export function exportProject(ctx: WebMcpContext, input: RevisionInput): Promise<ToolResult> {
  const revisionFailure = stale(ctx, input);
  if (revisionFailure) return Promise.resolve(revisionFailure);
  if (!policy(ctx).export) return Promise.resolve(fail(ctx, 'PERMISSION_DENIED', 'Project export is disabled'));
  return call(ctx, ctx.exportProject, 'Project export is unavailable', 'Exported project');
}

export function publishProject(ctx: WebMcpContext, input: RevisionInput): Promise<ToolResult> {
  const revisionFailure = stale(ctx, input);
  if (revisionFailure) return Promise.resolve(revisionFailure);
  if (!policy(ctx).publish) return Promise.resolve(fail(ctx, 'PERMISSION_DENIED', 'Project publish is disabled'));
  return call(ctx, ctx.publishProject, 'Project publish is unavailable', 'Published project');
}

export function previewProject(
  ctx: WebMcpContext,
  input: { sequenceId?: string } = {},
): Promise<ToolResult> {
  return call(
    ctx,
    ctx.previewProject ? () => ctx.previewProject!(input.sequenceId) : undefined,
    'Project preview is unavailable',
    'Opened project preview',
  );
}

export async function executePublicProjectTool(
  ctx: WebMcpContext,
  name: PublicProjectToolName,
  input: Record<string, unknown> = {},
): Promise<ToolResult> {
  switch (name) {
    case 'newProject': return newProject(ctx, input as never);
    case 'listProjects': return listProjects(ctx);
    case 'openProject': return openProject(ctx, input as never);
    case 'editProject': return editProject(ctx, input as never);
    case 'importProject': return importProject(ctx, input as never);
    case 'saveProject': return saveProject(ctx, input as never);
    case 'exportProject': return exportProject(ctx, input as never);
    case 'publishProject': return publishProject(ctx, input as never);
    case 'previewProject': return previewProject(ctx, input as never);
  }
}
