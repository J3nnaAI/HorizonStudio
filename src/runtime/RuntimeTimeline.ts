/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SequenceEvaluator } from '../core/evaluator';
import type { DriverType, Sequence } from '../core/types';

export interface TimelineRuntimeContext {
  evaluator: SequenceEvaluator;
  select(sequence: Sequence): void;
  emit(name: string, detail?: unknown): void;
}

export class RuntimeTimeline {
  constructor(
    readonly publicName: string,
    readonly sequence: Sequence,
    private context: TimelineRuntimeContext,
  ) {}

  private select(): SequenceEvaluator {
    this.context.select(this.sequence);
    return this.context.evaluator;
  }

  play(): this {
    this.select().play();
    this.context.emit('timeline:start', {
      timeline: this.publicName,
      sequenceId: this.sequence.id,
    });
    return this;
  }

  pause(): this {
    this.select().pause();
    this.context.emit('timeline:pause', { timeline: this.publicName });
    return this;
  }

  seek(time: number): this {
    if (!Number.isFinite(time)) throw new TypeError('Timeline time must be finite');
    this.select().seek(time);
    return this;
  }

  progress(progress: number): this {
    if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
      throw new RangeError('Timeline progress must be between 0 and 1');
    }
    const evaluator = this.select();
    evaluator.setManualProgress(progress);
    evaluator.setDriver('manual', { progress });
    return this;
  }

  rate(rate: number): this {
    if (!Number.isFinite(rate)) throw new TypeError('Timeline rate must be finite');
    this.select().setPlaybackRate(rate);
    return this;
  }

  stop(): this {
    const evaluator = this.select();
    evaluator.pause();
    evaluator.seek(0);
    this.context.emit('timeline:stop', { timeline: this.publicName });
    return this;
  }

  setDriver(driver: DriverType): this {
    this.select().setDriver(driver);
    return this;
  }
}
