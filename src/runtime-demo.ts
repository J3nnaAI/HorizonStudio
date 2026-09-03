/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Horizon } from './runtime/HorizonRuntime';
import { buildPersistenceHeroProject } from './demo/persistenceHero';
import type { HorizonProject } from './core/types';

const previewToken = new URLSearchParams(location.search).get('preview');
const previewKey = previewToken ? `horizon:runtime-preview:${previewToken}` : '';
const previewSource = previewKey ? sessionStorage.getItem(previewKey) : null;
const project = previewSource
  ? JSON.parse(previewSource) as HorizonProject
  : buildPersistenceHeroProject();
const experienceSequenceId = typeof project.metadata.runtimeExperienceSequenceId === 'string'
  ? project.metadata.runtimeExperienceSequenceId
  : undefined;
const activeSequenceId = project.compositions[project.activeCompositionId]?.sequence;
const authoredDriver = activeSequenceId
  ? project.sequences[activeSequenceId]?.defaultDriver ?? 'time'
  : 'time';
const lookAroundEnabled = Boolean(
  (project.metadata.runtimeLookAround as { enabled?: boolean } | undefined)?.enabled,
);

if (previewSource) {
  document.title = `${project.name} · Browser Preview`;
  document.body.classList.add('is-preview');
  if (authoredDriver === 'scroll') document.body.classList.add('is-scroll-preview');
  const hint = document.querySelector<HTMLElement>('#preview-hint');
  if (hint) {
    hint.hidden = false;
    hint.textContent = authoredDriver === 'scroll'
      ? lookAroundEnabled
        ? 'SCROLL TO TRAVEL · DRAG TO LOOK · DOUBLE-CLICK TO RECENTER'
        : 'SCROLL TO EXPLORE'
      : authoredDriver === 'pointer'
        ? 'MOVE THE POINTER'
        : authoredDriver === 'external'
          ? 'LIVE RUNTIME · READY FOR DATA'
          : 'LIVE RUNTIME PREVIEW';
    window.setTimeout(() => hint.classList.add('fade'), 3200);
    window.setTimeout(() => { hint.hidden = true; }, 3900);
  }
}

Horizon.mount('#hero', project).then((hero) => {
  (window as Window & { HorizonPreview?: typeof hero }).HorizonPreview = hero;
  if (experienceSequenceId && project.sequences[experienceSequenceId]) {
    hero.timeline(project.sequences[experienceSequenceId].name).play();
  }
  if (previewSource) return;
  const textInput = document.querySelector('#text-input') as HTMLInputElement;
  const energyInput = document.querySelector('#energy-input') as HTMLInputElement;
  const applyBtn = document.querySelector('#apply-btn')!;
  const playBtn = document.querySelector('#play-btn')!;

  applyBtn.addEventListener('click', () => {
    hero.update({
      'word.text': textInput.value,
      'horizon.energy': parseFloat(energyInput.value),
    });
  });

  playBtn.addEventListener('click', () => {
    hero.timeline('intro').play();
  });
});
