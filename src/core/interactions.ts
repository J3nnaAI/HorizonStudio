/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HorizonProject } from './types';

export type InteractionTrigger =
  | 'click'
  | 'tap'
  | 'pointerEnter'
  | 'pointerLeave'
  | 'pointerDown'
  | 'pointerUp'
  | 'pointerMove'
  | 'keyDown'
  | 'keyUp'
  | 'selection'
  | 'marker'
  | 'timeline'
  | 'custom';

export type InteractionAction =
  | { type: 'setProperty'; publicName: string; value: unknown }
  | { type: 'emit'; event: string; detail?: unknown }
  | { type: 'timeline'; timeline: string; command: 'play' | 'pause' | 'stop' | 'progress' | 'seek'; value?: number }
  | {
      type: 'navigate';
      command: 'next' | 'previous' | 'nextReveal' | 'goTo' | 'enter' | 'exit';
      slide?: number | string;
    };

export interface InteractionBehavior {
  id: string;
  name: string;
  nodeId?: string;
  enabled: boolean;
  trigger: InteractionTrigger;
  event?: string;
  key?: string;
  marker?: string;
  actions: InteractionAction[];
}

export interface InteractionContext {
  setProperty(name: string, value: unknown): void;
  emit(name: string, detail?: unknown): void;
  controlTimeline(
    name: string,
    command: 'play' | 'pause' | 'stop' | 'progress' | 'seek',
    value?: number,
  ): void;
  navigate?(
    command: 'next' | 'previous' | 'nextReveal' | 'goTo' | 'enter' | 'exit',
    slide?: number | string,
  ): void;
}

function isBehavior(value: unknown): value is InteractionBehavior {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InteractionBehavior>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.trigger === 'string' &&
    typeof candidate.enabled === 'boolean' &&
    Array.isArray(candidate.actions)
  );
}

/** Executes declarative project actions without evaluating project JavaScript. */
export class InteractionRuntime {
  constructor(
    private project: HorizonProject,
    private context: InteractionContext,
  ) {}

  updateProject(project: HorizonProject): void {
    this.project = project;
  }

  dispatch(
    trigger: InteractionTrigger,
    detail: {
      nodeId?: string;
      event?: string;
      key?: string;
      marker?: string;
      payload?: unknown;
    } = {},
  ): number {
    let executed = 0;
    for (const value of Object.values(this.project.behaviors)) {
      if (!isBehavior(value) || !value.enabled || value.trigger !== trigger) continue;
      if (value.nodeId && value.nodeId !== detail.nodeId) continue;
      if (value.event && value.event !== detail.event) continue;
      if (value.key && value.key.toLowerCase() !== detail.key?.toLowerCase()) continue;
      if (value.marker && value.marker !== detail.marker) continue;
      for (const action of value.actions) {
        switch (action.type) {
          case 'setProperty':
            this.context.setProperty(action.publicName, structuredClone(action.value));
            break;
          case 'emit':
            this.context.emit(action.event, structuredClone(action.detail));
            break;
          case 'timeline':
            this.context.controlTimeline(action.timeline, action.command, action.value);
            break;
          case 'navigate':
            this.context.navigate?.(action.command, action.slide);
            break;
        }
        executed++;
      }
    }
    return executed;
  }
}
