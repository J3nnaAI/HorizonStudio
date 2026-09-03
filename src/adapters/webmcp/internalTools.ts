/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolResult } from '../../core/types';
import type { WebMcpContext } from './tools';
import { executePublicComponentTool, resolvePublicToolName } from './componentTools';
import * as semantic from './semanticTools';
import * as tools from './tools';

export function executePublicComponentToolViaAlias(
  ctx: WebMcpContext,
  name: string,
  input: Record<string, unknown> = {},
): ToolResult | Promise<ToolResult> {
  const resolved = resolvePublicToolName(name);
  if (resolved) return executePublicComponentTool(ctx, resolved, input);
  return {
    ok: false,
    error: `Unknown public component tool alias: ${name}`,
    summary: `Unknown public component tool alias: ${name}`,
  };
}

/** Full legacy/specialized tool dispatch — internal only, not registered with MCP hosts. */
export function executeInternalWebMcpTool(
  ctx: WebMcpContext,
  name: string,
  input: Record<string, unknown> = {},
): ToolResult | Promise<ToolResult> {
  const publicAlias = resolvePublicToolName(name);
  if (publicAlias) return executePublicComponentTool(ctx, publicAlias, input);

  switch (name) {
    case 'horizon_project_describe':
      return semantic.projectInspect(ctx);
    case 'horizon_scene_describe':
      return semantic.sceneInspect(ctx, input);
    case 'horizon_selection_get':
      return semantic.selectionInspect(ctx);
    case 'horizon_history_recent':
      return tools.getHistoryRecent(ctx, (input.limit as number) ?? 10);
    case 'horizon_object_create':
      return tools.objectCreate(ctx, input as never);
    case 'horizon_object_transform':
      return tools.objectTransform(ctx, input as never);
    case 'horizon_text_set':
      return tools.textSet(ctx, input as never);
    case 'horizon_material_assign':
      return tools.materialAssign(ctx, input as never);
    case 'horizon_material_parameters_set':
      return tools.materialParametersSet(ctx, input as never);
    case 'horizon_shader_parameters_set':
      return tools.shaderParametersSet(ctx, input as never);
    case 'horizon_camera_frame':
      return tools.cameraFrame(ctx, input as never);
    case 'horizon_camera_lens_set':
      return tools.cameraLensSet(ctx, input as never);
    case 'horizon_environment_set':
      return tools.environmentSet(ctx, input as never);
    case 'horizon_sequence_create':
      return tools.sequenceCreate(ctx, input as never);
    case 'horizon_keyframes_set':
      return tools.keyframesSet(ctx, input as never);
    case 'horizon_sequence_driver_set':
      return tools.sequenceDriverSet(ctx, input as never);
    case 'horizon_public_property_expose':
      return tools.publicPropertyExpose(ctx, input as never);
    case 'horizon_preview_render':
    case 'horizon_render_snapshot':
      return semantic.renderSnapshot(ctx, input);
    case 'horizon_render_settings_set':
      return tools.renderSettingsSet(ctx, input as never);
    case 'horizon_renderer_capabilities':
      return tools.rendererCapabilities(ctx);
    case 'horizon_registry_describe':
      return semantic.registryInspect(ctx);
    case 'horizon_variant_create':
      return tools.variantCreate(ctx, input as never);
    case 'horizon_capabilities_get':
      return semantic.capabilitiesGet(ctx);
    case 'horizon_timeline_describe':
      return semantic.timelineInspect(ctx, input);
    case 'horizon_property_find':
      return semantic.propertyFind(ctx, input);
    case 'horizon_properties_set':
      return semantic.propertiesSet(ctx, input as never);
    case 'horizon_object_update':
      return semantic.nodeUpdate(ctx, input as never);
    case 'horizon_object_delete':
      return semantic.nodeDelete(ctx, input as never);
    case 'horizon_asset_import':
      return semantic.assetImport(ctx, input as never);
    case 'horizon_material_create':
      return semantic.materialCreate(ctx, input as never);
    case 'horizon_field_parameters_set':
      return semantic.fieldParametersSet(ctx, input as never);
    case 'horizon_shader_create':
      return semantic.shaderCreate(ctx, input as never);
    case 'horizon_track_create':
      return semantic.trackCreate(ctx, input as never);
    case 'horizon_sequence_update':
      return semantic.sequenceUpdate(ctx, input as never);
    case 'horizon_track_update':
      return semantic.trackUpdate(ctx, input as never);
    case 'horizon_clip_upsert':
      return semantic.clipUpsert(ctx, input as never);
    case 'horizon_marker_add':
      return semantic.markerAdd(ctx, input as never);
    case 'horizon_timeline_delete':
      return semantic.timelineDelete(ctx, input as never);
    case 'horizon_public_contract_set':
      return semantic.publicContractSet(ctx, input as never);
    case 'horizon_interaction_upsert':
      return semantic.interactionUpsert(ctx, input as never);
    case 'horizon_presentation_set':
      return semantic.presentationSet(ctx, input as never);
    case 'horizon_variant_update':
      return semantic.variantUpdate(ctx, input as never);
    case 'horizon_render_enqueue':
      return semantic.renderEnqueue(ctx, input as never);
    case 'horizon_render_status':
      return semantic.renderStatus(ctx, input);
    case 'horizon_render_cancel':
      return semantic.renderCancel(ctx, input as never);
    case 'horizon_publish_prepare':
      return semantic.publishPlan(ctx);
    case 'horizon_project_save':
      return semantic.projectSave(ctx, input as never);
    case 'horizon_project_export':
      return semantic.projectExport(ctx, input as never);
    case 'horizon_project_publish':
      return semantic.projectPublish(ctx, input as never);
    default:
      return {
        ok: false,
        error: `Unknown tool: ${name}`,
        summary: `Unknown tool: ${name}`,
      };
  }
}

export const INTERNAL_WEBMCP_TOOL_NAMES = [
  'horizon_project_describe',
  'horizon_scene_describe',
  'horizon_selection_get',
  'horizon_history_recent',
  'horizon_object_create',
  'horizon_object_transform',
  'horizon_text_set',
  'horizon_material_assign',
  'horizon_material_parameters_set',
  'horizon_shader_parameters_set',
  'horizon_camera_frame',
  'horizon_camera_lens_set',
  'horizon_environment_set',
  'horizon_sequence_create',
  'horizon_keyframes_set',
  'horizon_sequence_driver_set',
  'horizon_public_property_expose',
  'horizon_preview_render',
  'horizon_variant_create',
  'horizon_render_settings_set',
  'horizon_renderer_capabilities',
  'horizon_registry_describe',
  'horizon_capabilities_get',
  'horizon_timeline_describe',
  'horizon_property_find',
  'horizon_properties_set',
  'horizon_object_update',
  'horizon_object_delete',
  'horizon_asset_import',
  'horizon_material_create',
  'horizon_field_parameters_set',
  'horizon_shader_create',
  'horizon_track_create',
  'horizon_sequence_update',
  'horizon_track_update',
  'horizon_clip_upsert',
  'horizon_marker_add',
  'horizon_timeline_delete',
  'horizon_public_contract_set',
  'horizon_interaction_upsert',
  'horizon_presentation_set',
  'horizon_variant_update',
  'horizon_render_snapshot',
  'horizon_render_enqueue',
  'horizon_render_status',
  'horizon_render_cancel',
  'horizon_publish_prepare',
  'horizon_project_save',
  'horizon_project_export',
  'horizon_project_publish',
] as const;
