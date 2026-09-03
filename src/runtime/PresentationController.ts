/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HorizonProject } from '../core/types';

export interface PresentationSlide {
  composition: string;
  sequence?: string;
  variant?: string;
}

export interface PresentationDefinition {
  slides: PresentationSlide[];
  autoplay: boolean;
  intervalSeconds: number;
  loop: boolean;
  clickToAdvance: boolean;
}

export interface PresentationState {
  slideIndex: number;
  compositionId: string;
  revealIndex: number;
  revealCount: number;
  revealTime?: number;
  variantId?: string;
  active: boolean;
}

export function presentationDefinition(project: HorizonProject): PresentationDefinition {
  const saved = project.metadata.presentation as
    | (Partial<Omit<PresentationDefinition, 'slides'>> & {
        slides?: Array<string | PresentationSlide>;
      })
    | undefined;
  const slides = (saved?.slides ?? Object.keys(project.compositions))
    .map((slide) => (typeof slide === 'string' ? { composition: slide } : slide))
    .filter((slide) => Boolean(project.compositions[slide.composition]));
  if (slides.length === 0 && project.activeCompositionId) {
    slides.push({ composition: project.activeCompositionId });
  }
  return {
    slides,
    autoplay: saved?.autoplay ?? false,
    intervalSeconds: Math.max(0.25, saved?.intervalSeconds ?? 8),
    loop: saved?.loop ?? false,
    clickToAdvance: saved?.clickToAdvance ?? true,
  };
}

export class PresentationController extends EventTarget {
  private definition: PresentationDefinition;
  private slideIndex = 0;
  private revealIndex = -1;
  private timer: ReturnType<typeof setInterval> | undefined;
  private active = false;
  private completed = false;

  constructor(private project: HorizonProject) {
    super();
    this.definition = presentationDefinition(project);
    const active = this.definition.slides.findIndex(
      (slide) => slide.composition === project.activeCompositionId,
    );
    this.slideIndex = Math.max(0, active);
  }

  updateProject(project: HorizonProject): void {
    this.project = project;
    this.definition = presentationDefinition(project);
    const active = this.definition.slides.findIndex(
      (slide) => slide.composition === project.activeCompositionId,
    );
    if (active >= 0) this.slideIndex = active;
    this.revealIndex = Math.min(this.revealIndex, this.revealMarkers().length - 1);
  }

  state(): PresentationState {
    const reveal = this.revealMarkers()[this.revealIndex];
    return {
      slideIndex: this.slideIndex,
      compositionId:
        this.definition.slides[this.slideIndex]?.composition ??
        this.project.activeCompositionId,
      revealIndex: this.revealIndex,
      revealCount: this.revealMarkers().length,
      revealTime: reveal?.time,
      variantId: this.definition.slides[this.slideIndex]?.variant,
      active: this.active,
    };
  }

  getDefinition(): PresentationDefinition {
    return structuredClone(this.definition);
  }

  includesComposition(compositionId: string): boolean {
    return this.definition.slides.some((slide) => slide.composition === compositionId);
  }

  enter(allowAutoplay = true): PresentationState {
    if (this.active) return this.state();
    this.active = true;
    this.completed = false;
    const state = this.emitChange('mode');
    if (allowAutoplay && this.definition.autoplay) this.startAutoplay();
    return state;
  }

  exit(): PresentationState {
    if (!this.active) return this.state();
    this.active = false;
    this.stopAutoplay();
    return this.emitChange('mode');
  }

  goTo(indexOrId: number | string): PresentationState {
    const index =
      typeof indexOrId === 'string'
        ? this.definition.slides.findIndex(
            (slide) => slide.composition === indexOrId,
          )
        : Math.round(indexOrId);
    if (index < 0 || index >= this.definition.slides.length) {
      throw new Error(`Presentation slide not found: ${String(indexOrId)}`);
    }
    this.slideIndex = index;
    this.revealIndex = -1;
    this.completed = false;
    this.project.activeCompositionId = this.definition.slides[index].composition;
    return this.emitChange('slide');
  }

  nextReveal(): PresentationState {
    const markers = this.revealMarkers();
    if (this.revealIndex + 1 < markers.length) {
      this.revealIndex++;
      return this.emitChange('reveal');
    }
    return this.next();
  }

  next(): PresentationState {
    if (this.slideIndex + 1 < this.definition.slides.length) {
      return this.goTo(this.slideIndex + 1);
    }
    if (this.definition.loop && this.definition.slides.length > 0) return this.goTo(0);
    this.stopAutoplay();
    const state = this.state();
    if (!this.completed) {
      this.completed = true;
      this.dispatchEvent(new CustomEvent('complete', { detail: state }));
    }
    return state;
  }

  previous(): PresentationState {
    if (this.revealIndex >= 0) {
      this.revealIndex--;
      return this.emitChange('reveal');
    }
    if (this.slideIndex > 0) {
      const state = this.goTo(this.slideIndex - 1);
      this.revealIndex = this.revealMarkers().length - 1;
      return this.emitChange('reveal');
    }
    return this.state();
  }

  startAutoplay(): void {
    this.stopAutoplay();
    this.timer = setInterval(
      () => this.nextReveal(),
      this.definition.intervalSeconds * 1000,
    );
  }

  stopAutoplay(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private revealMarkers() {
    const composition = this.project.compositions[this.project.activeCompositionId];
    const sequence = composition?.sequence
      ? this.project.sequences[composition.sequence]
      : undefined;
    return (sequence?.markers ?? [])
      .filter((marker) => marker.name.toLowerCase().startsWith('reveal'))
      .sort((a, b) => a.time - b.time);
  }

  private emitChange(reason: 'slide' | 'reveal' | 'mode'): PresentationState {
    const state = this.state();
    this.dispatchEvent(new CustomEvent('change', { detail: { reason, ...state } }));
    return state;
  }

  dispose(): void {
    this.stopAutoplay();
  }
}
