/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  EvalSnapshot,
} from '../core/evaluator';
import type {
  HorizonProject,
  ResponsiveFit,
  ResponsiveSettings,
  Variant,
} from '../core/types';

export const DEFAULT_RESPONSIVE_SETTINGS: ResponsiveSettings = {
  designWidth: 1920,
  designHeight: 1080,
  fit: 'contain',
  breakpoints: [],
  reducedMotionProgress: 1,
};

export interface ResponsiveState {
  width: number;
  height: number;
  aspect: number;
  fit: ResponsiveFit;
  variant?: Variant;
  reducedMotion: boolean;
}

export function responsiveSettings(project: HorizonProject): ResponsiveSettings {
  const saved = project.responsive;
  return {
    ...DEFAULT_RESPONSIVE_SETTINGS,
    ...saved,
    designWidth: Math.max(1, saved?.designWidth ?? DEFAULT_RESPONSIVE_SETTINGS.designWidth),
    designHeight: Math.max(1, saved?.designHeight ?? DEFAULT_RESPONSIVE_SETTINGS.designHeight),
    breakpoints: saved?.breakpoints ?? [],
  };
}

export function resolveResponsiveState(
  project: HorizonProject,
  width: number,
  height: number,
  reducedMotion = false,
): ResponsiveState {
  const settings = responsiveSettings(project);
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const aspect = safeWidth / safeHeight;
  const breakpoint = settings.breakpoints.find(
    (candidate) =>
      (candidate.minWidth === undefined || safeWidth >= candidate.minWidth) &&
      (candidate.maxWidth === undefined || safeWidth <= candidate.maxWidth) &&
      (candidate.minAspect === undefined || aspect >= candidate.minAspect) &&
      (candidate.maxAspect === undefined || aspect <= candidate.maxAspect),
  );
  const variantId =
    (reducedMotion && settings.reducedMotionVariantId) || breakpoint?.variantId;
  const variant = variantId ? project.variants[variantId] : undefined;
  return {
    width: safeWidth,
    height: safeHeight,
    aspect,
    fit: settings.fit,
    variant:
      variant && (!variant.base || variant.base === project.activeCompositionId)
        ? variant
        : undefined,
    reducedMotion,
  };
}

export function fitComposition(
  hostWidth: number,
  hostHeight: number,
  settings: ResponsiveSettings,
): { width: number; height: number } {
  const width = Math.max(1, hostWidth);
  const height = Math.max(1, hostHeight);
  if (settings.fit === 'fill') return { width, height };
  const designAspect = settings.designWidth / settings.designHeight;
  const hostAspect = width / height;
  const useWidth =
    settings.fit === 'contain'
      ? hostAspect <= designAspect
      : hostAspect >= designAspect;
  return useWidth
    ? { width, height: width / designAspect }
    : { width: height * designAspect, height };
}

function overrideKey(key: string): string | undefined {
  if (key.includes(':')) return key;
  const slash = key.indexOf('/');
  if (slash <= 0 || slash === key.length - 1) return undefined;
  return `${key.slice(0, slash)}:${key.slice(slash + 1)}`;
}

export function applyResponsiveOverrides(
  snapshot: EvalSnapshot,
  state: ResponsiveState,
): EvalSnapshot {
  if (!state.variant) return snapshot;
  const overrides = new Map(snapshot.overrides);
  for (const [rawKey, value] of Object.entries(state.variant.overrides)) {
    const key = overrideKey(rawKey);
    if (key) overrides.set(key, structuredClone(value));
  }
  return { ...snapshot, overrides };
}

export function systemPrefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;
}
