/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export { RenderCoordinator, RenderCoordinator as SceneAdapter } from './RenderCoordinator';
export type { RenderCoordinatorOptions } from './RenderCoordinator';
export type {
  RenderBackend,
  FrameStats,
  MasterRenderPass,
  OffscreenRenderRequest,
  OffscreenRenderResult,
} from './RenderBackend';
export { RenderQueue, MASTER_RENDER_PASSES } from './RenderQueue';
export type {
  RenderOutputArtifact,
  RenderQueueResult,
} from './RenderQueue';
export { MasterRenderScheduler } from './MasterRenderScheduler';
export type {
  MasterRenderOptions,
  MasterRenderPassResult,
  MasterRenderedFrame,
  MasterRenderResult,
} from './MasterRenderScheduler';
export { negotiateBackend, detectWebGpuSupport } from './CapabilityService';
export type { BackendSelection } from './CapabilityService';
