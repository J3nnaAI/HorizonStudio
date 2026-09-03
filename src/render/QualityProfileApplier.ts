/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HorizonProject, QualityProfile } from '../core/types';

export interface RenderCapabilityBudget {
  antialiasing: QualityProfile['antialiasing'];
  msaaSamples: number;
  renderScale: number;
  pixelRatioCap: number;
  shadowMapSize: number;
  reflectionResolution: number;
  bloomEnabled: boolean;
  bloomQuality: 'off' | 'low' | 'medium' | 'high';
  dofEnabled: boolean;
  dofQuality: 'off' | 'low' | 'medium' | 'high';
  ssaoQuality: 'off' | 'low' | 'medium' | 'high';
  ssrQuality: 'off' | 'low' | 'medium' | 'high';
  motionBlurQuality: 'off' | 'low' | 'medium' | 'high';
  volumetricSteps: number;
  volumetricShadowSteps: number;
  postQuality: 'low' | 'medium' | 'high';
  adaptive: boolean;
  frameTargetMs: number;
}

export function resolveQualityProfile(
  project: HorizonProject,
  profileId?: string,
): QualityProfile {
  const id = profileId ?? project.renderSettings.qualityProfileId;
  const profile = project.renderSettings.qualityProfiles[id];
  if (profile) return profile;
  const [fallback] = Object.values(project.renderSettings.qualityProfiles);
  return fallback ?? ({} as QualityProfile);
}

export function budgetFromProfile(profile: QualityProfile, post: HorizonProject['renderSettings']['post']): RenderCapabilityBudget {
  return {
    antialiasing: profile.antialiasing ?? 'smaa',
    msaaSamples: profile.msaaSamples ?? 2,
    renderScale: profile.renderScale ?? 1,
    pixelRatioCap: profile.pixelRatioCap ?? 2,
    shadowMapSize: profile.shadowMapSize ?? 1024,
    reflectionResolution: profile.reflectionResolution ?? 512,
    bloomEnabled: (post?.bloom.enabled ?? true) && (profile.bloomQuality ?? 'medium') !== 'off',
    bloomQuality: profile.bloomQuality ?? 'medium',
    dofEnabled: (post?.dof.enabled ?? false) && (profile.dofQuality ?? 'medium') !== 'off',
    dofQuality: profile.dofQuality ?? 'medium',
    ssaoQuality: profile.ssaoQuality ?? 'off',
    ssrQuality: profile.ssrQuality ?? 'off',
    motionBlurQuality: profile.motionBlurQuality ?? 'off',
    volumetricSteps: profile.volumetricSteps ?? 24,
    volumetricShadowSteps: profile.volumetricShadowSteps ?? 4,
    postQuality: profile.postQuality ?? 'medium',
    adaptive: profile.adaptive ?? true,
    frameTargetMs: profile.frameTargetMs ?? 16.7,
  };
}
