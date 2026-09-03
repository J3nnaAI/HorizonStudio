/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BackendCapabilities } from '../core/types';

export interface BackendSelection {
  backend: 'webgpu' | 'webgl';
  capabilities: BackendCapabilities;
  fallbackReason?: string;
}

export async function detectWebGpuSupport(): Promise<{
  available: boolean;
  adapter?: GPUAdapter;
  limits?: GPUSupportedLimits;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const nav = typeof globalThis !== 'undefined' ? (globalThis as { navigator?: Navigator }).navigator : undefined;
  if (!nav || !('gpu' in nav)) {
    return { available: false, warnings: ['WebGPU not available in this browser'] };
  }
  try {
    const adapter = await nav.gpu!.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      return { available: false, warnings: ['No WebGPU adapter found'] };
    }
    const limits = adapter.limits;
    return { available: true, adapter, limits, warnings };
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
    return { available: false, warnings };
  }
}

export async function negotiateBackend(
  preference: 'auto' | 'webgpu' | 'webgl' = 'auto',
): Promise<BackendSelection> {
  const webgpu = await detectWebGpuSupport();
  const degradedFeatures: string[] = [];
  const warnings: string[] = [];

  if (preference === 'webgl') {
    return {
      backend: 'webgl',
      fallbackReason: 'WebGL forced by preference',
      capabilities: {
        backend: 'webgl',
        supportsMRT: false,
        supportsTimestampQuery: false,
        supportsCompute: false,
        supportsFloat32Filter: false,
        supportsFloat16Filter: false,
        supportsHDR: false,
        maxTextureSize: 4096,
        maxSamples: 8,
        maxColorAttachments: 1,
        reportedName: 'WebGL',
        warnings: ['WebGL backend selected'],
        degradedFeatures: ['ssr', 'mrt', 'compute', 'timestampQuery', 'float32Filter', 'hdrOutput'],
      },
    };
  }

  if (webgpu.available && (preference === 'auto' || preference === 'webgpu')) {
    const maxTextureSize = webgpu.limits?.maxTextureDimension2D ?? 8192;
    const maxColorAttachments = webgpu.limits?.maxColorAttachments ?? 4;
    return {
      backend: 'webgpu',
      capabilities: {
        backend: 'webgpu',
        supportsMRT: maxColorAttachments > 1,
        supportsTimestampQuery: true,
        supportsCompute: true,
        supportsFloat32Filter: true,
        supportsFloat16Filter: true,
        supportsHDR: true,
        maxTextureSize,
        maxSamples: 8,
        maxColorAttachments,
        reportedName: 'WebGPU',
        vendor: webgpu.adapter?.info?.vendor,
        device: webgpu.adapter?.info?.device,
        warnings: webgpu.warnings,
        degradedFeatures,
      },
    };
  }

  warnings.push(...webgpu.warnings);
  degradedFeatures.push('ssr', 'mrt', 'compute', 'timestampQuery', 'float32Filter', 'hdrOutput');
  return {
    backend: 'webgl',
    fallbackReason: webgpu.warnings.join('; ') || 'WebGPU unavailable',
    capabilities: {
      backend: 'webgl',
      supportsMRT: false,
      supportsTimestampQuery: false,
      supportsCompute: false,
      supportsFloat32Filter: false,
      supportsFloat16Filter: false,
      supportsHDR: false,
      maxTextureSize: 4096,
      maxSamples: 8,
      maxColorAttachments: 1,
      reportedName: 'WebGL',
      warnings,
      degradedFeatures,
    },
  };
}
