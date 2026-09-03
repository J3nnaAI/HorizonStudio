/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { InteractionRuntime, InteractionTrigger } from '../core/interactions';

function nodeId(target: EventTarget | null): string | undefined {
  return target instanceof Element
    ? target.closest<HTMLElement>('[data-horizon-node-id]')?.dataset.horizonNodeId
    : undefined;
}

/**
 * Connects browser input to the declarative interaction model. WebGL picks are
 * forwarded separately through dispatchPickedClick.
 */
export class InteractionBindings {
  private abort = new AbortController();
  private hoveredNode?: string;

  constructor(
    private element: HTMLElement,
    private runtime: InteractionRuntime,
    private keyboardTarget: Window | HTMLElement = window,
  ) {
    this.bind();
  }

  updateRuntime(runtime: InteractionRuntime): void {
    this.runtime = runtime;
  }

  dispatchPickedClick(nodeId: string | null): void {
    this.runtime.dispatch('click', { nodeId: nodeId ?? undefined });
  }

  private dispatchPointer(trigger: InteractionTrigger, event: PointerEvent): void {
    const id = nodeId(event.target);
    if (!id) return;
    this.runtime.dispatch(trigger, {
      nodeId: id,
      event: event.pointerType,
      payload: {
        pointerType: event.pointerType,
        button: event.button,
        x: event.clientX,
        y: event.clientY,
      },
    });
  }

  private bind(): void {
    const signal = this.abort.signal;
    this.element.addEventListener(
      'click',
      (event) => {
        const id = nodeId(event.target);
        if (id) this.runtime.dispatch('click', { nodeId: id });
      },
      { signal },
    );
    this.element.addEventListener(
      'pointerdown',
      (event) => this.dispatchPointer('pointerDown', event),
      { signal },
    );
    this.element.addEventListener(
      'pointerup',
      (event) => {
        this.dispatchPointer('pointerUp', event);
        const id = nodeId(event.target);
        if (event.pointerType === 'touch' && id) {
          this.runtime.dispatch('tap', {
            nodeId: id,
            event: event.pointerType,
          });
        }
      },
      { signal },
    );
    this.element.addEventListener(
      'pointermove',
      (event) => {
        this.dispatchPointer('pointerMove', event);
        const next = nodeId(event.target);
        if (next === this.hoveredNode) return;
        if (this.hoveredNode) {
          this.runtime.dispatch('pointerLeave', { nodeId: this.hoveredNode });
        }
        if (next) this.runtime.dispatch('pointerEnter', { nodeId: next });
        this.hoveredNode = next;
      },
      { signal, passive: true },
    );
    this.element.addEventListener(
      'pointerleave',
      () => {
        if (this.hoveredNode) {
          this.runtime.dispatch('pointerLeave', { nodeId: this.hoveredNode });
          this.hoveredNode = undefined;
        }
      },
      { signal },
    );
    this.keyboardTarget.addEventListener(
      'keydown',
      (event) => {
        const keyboard = event as KeyboardEvent;
        this.runtime.dispatch('keyDown', { key: keyboard.key, event: keyboard.code });
      },
      { signal },
    );
    this.keyboardTarget.addEventListener(
      'keyup',
      (event) => {
        const keyboard = event as KeyboardEvent;
        this.runtime.dispatch('keyUp', { key: keyboard.key, event: keyboard.code });
      },
      { signal },
    );
  }

  dispose(): void {
    this.abort.abort();
  }
}
