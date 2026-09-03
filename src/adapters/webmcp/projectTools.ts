/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolResult } from '../../core/types';
import type { WebMcpContext, WebMcpPermissions } from './tools';
import { WEBMCP_TOOL_VERSION } from './semanticTools';
import { editProject } from './projectEdit';
import { createImageShader, IMAGE_SHADER_ID } from '../../shaders/image';

export const PUBLIC_PROJECT_TOOL_NAMES = [
  'newProject',
  'listProjects',
  'openProject',
  'editProject',
  'placeImage',
  'importProject',
  'saveProject',
  'exportProject',
  'publishProject',
  'previewProject',
] as const;

export type PublicProjectToolName = typeof PUBLIC_PROJECT_TOOL_NAMES[number];

type RevisionInput = { expectedRevision?: number };

type PlaceImageInput = RevisionInput & {
  dataUrl?: string;
  name?: string;
  target?: 'stage' | 'environment';
  compositionId?: string;
  parentId?: string;
  position?: [number, number, number];
  rotation?: [number, number, number];
  width?: number;
  height?: number;
  opacity?: number;
  intent?: string;
};

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

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

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('The image could not be read'));
    reader.readAsDataURL(blob);
  });
}

async function imageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      const dimensions = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return dimensions;
    } catch {
      // SVG and less common browser image formats can still decode through Image.
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Import an image and make it visible without requiring callers to know Horizon's asset/material/node graph. */
export async function placeImage(ctx: WebMcpContext, input: PlaceImageInput): Promise<ToolResult> {
  const revisionFailure = stale(ctx, input);
  if (revisionFailure) return revisionFailure;
  if (!policy(ctx).import) return fail(ctx, 'PERMISSION_DENIED', 'Image import is disabled');
  if (!input.dataUrl?.startsWith('data:image/')) {
    return fail(ctx, 'INVALID_INPUT', 'Provide the image itself as a data:image/... URL');
  }

  try {
    const response = await fetch(input.dataUrl);
    if (!response.ok) throw new Error('The supplied image data could not be read');
    const blob = await response.blob();
    if (blob.size > MAX_IMAGE_BYTES) throw new Error('The image is larger than 50 MB');
    const mimeType = blob.type.split(';', 1)[0];
    if (!mimeType.startsWith('image/')) throw new Error(`The source is not an image (${mimeType || 'unknown type'})`);
    const dimensions = await imageDimensions(blob);
    if (!dimensions.width || !dimensions.height) throw new Error('The image dimensions could not be read');
    const dataUrl = await blobToDataUrl(blob);
    const target = input.target ?? 'stage';
    const compositionId = input.compositionId ?? ctx.bus.project.activeCompositionId;
    const composition = ctx.bus.project.compositions[compositionId];
    if (!composition) return fail(ctx, 'NOT_FOUND', `Composition not found: ${compositionId}`);
    const name = input.name?.trim() || 'Imported Image';
    const assetValue = {
      name,
      kind: 'image',
      mimeType,
      storage: 'inline',
      importedAt: new Date().toISOString(),
      dataUrl,
      size: blob.size,
      width: dimensions.width,
      height: dimensions.height,
      source: 'webmcp-image-import',
      metadata: {},
    };

    const operations: Array<Record<string, unknown> & { op: string }> = [];
    if (!ctx.bus.project.shaders[IMAGE_SHADER_ID]) {
      operations.push({ op: 'createShader', id: IMAGE_SHADER_ID, value: createImageShader() });
    }
    operations.push({ op: 'createAsset', ref: 'imageAsset', value: assetValue });

    if (target === 'environment') {
      operations.push({
        op: 'patchEntity',
        collection: 'compositions',
        entityId: compositionId,
        patch: {
          environment: {
            ...structuredClone(composition.environment),
            background: {
              ...structuredClone(composition.environment.background),
              mode: 'image',
              visible: true,
              imageAssetId: '@imageAsset',
            },
          },
        },
      });
    } else {
      const aspect = dimensions.width / dimensions.height;
      const suggested = ctx.scene.getPastePlaneTransform(aspect);
      let width = input.width ?? suggested.width;
      let height = input.height ?? suggested.height;
      if (input.width !== undefined && input.height === undefined) height = input.width / aspect;
      if (input.height !== undefined && input.width === undefined) width = input.height * aspect;
      if (!(width > 0) || !(height > 0)) throw new Error('Image width and height must be greater than zero');
      operations.push(
        {
          op: 'createMaterial',
          ref: 'imageMaterial',
          value: {
            name: `${name} Material`,
            shaderId: IMAGE_SHADER_ID,
            parameters: {
              assetId: '@imageAsset',
              opacity: Math.max(0, Math.min(1, input.opacity ?? 1)),
              roughness: 0.78,
              doubleSided: true,
            },
          },
        },
        {
          op: 'createNode',
          ref: 'imageNode',
          value: {
            type: 'mesh',
            name,
            compositionId,
            parentId: input.parentId,
            properties: {
              'mesh.primitive': 'plane',
              'mesh.width': width,
              'mesh.height': height,
              'transform.position': input.position ?? suggested.position,
              'transform.rotation': input.rotation ?? suggested.rotation,
            },
            components: { materialId: '@imageMaterial' },
            tags: ['webmcp-image', '2d-plane'],
          },
        },
      );
    }

    const edited = await editProject(ctx, {
      expectedRevision: input.expectedRevision,
      intent: input.intent ?? `Place image: ${name}`,
      operations,
    });
    if (!edited.ok) return edited;
    const refs = (edited.data as { refs?: Record<string, string> } | undefined)?.refs ?? {};
    if (target === 'stage' && refs.imageNode) ctx.setSelection([refs.imageNode]);
    return {
      ...edited,
      summary: target === 'environment'
        ? `Placed ${name} in the environment`
        : `Placed ${name} on the stage`,
      data: {
        ...(edited.data as Record<string, unknown> | undefined),
        target,
        assetId: refs.imageAsset,
        nodeId: refs.imageNode,
        dimensions,
      },
    };
  } catch (error) {
    return fail(ctx, 'IMAGE_IMPORT_FAILED', error instanceof Error ? error.message : String(error));
  }
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
    case 'placeImage': return placeImage(ctx, input as never);
    case 'importProject': return importProject(ctx, input as never);
    case 'saveProject': return saveProject(ctx, input as never);
    case 'exportProject': return exportProject(ctx, input as never);
    case 'publishProject': return publishProject(ctx, input as never);
    case 'previewProject': return previewProject(ctx, input as never);
  }
}
