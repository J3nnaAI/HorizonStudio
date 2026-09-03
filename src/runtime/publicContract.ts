/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandBus } from '../core/commandBus';
import { buildSetPropertyCommand } from '../core/commands';
import { createId } from '../core/ids';
import { getProperty } from '../core/project';
import type { HorizonProject, PublicProperty, PropertyType, Sequence } from '../core/types';

function numberArray(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((part) => typeof part === 'number' && Number.isFinite(part))
  );
}

export function validatePublicValue(property: PublicProperty, value: unknown): void {
  const type: PropertyType = property.type;
  let valid = false;
  switch (type) {
    case 'boolean':
      valid = typeof value === 'boolean';
      break;
    case 'integer':
      valid = typeof value === 'number' && Number.isInteger(value);
      break;
    case 'number':
      valid = typeof value === 'number' && Number.isFinite(value);
      break;
    case 'string':
    case 'color':
    case 'enum':
    case 'reference':
    case 'texture':
    case 'asset':
      valid = typeof value === 'string';
      break;
    case 'vec2':
      valid = numberArray(value, 2);
      break;
    case 'vec3':
      valid = numberArray(value, 3);
      break;
    case 'vec4':
    case 'quaternion':
      valid = numberArray(value, 4);
      break;
  }
  if (!valid) throw new TypeError(`Invalid ${type} value for "${property.publicName}"`);
  if (typeof value === 'number') {
    if (property.min !== undefined && value < property.min) {
      throw new RangeError(`"${property.publicName}" must be at least ${property.min}`);
    }
    if (property.max !== undefined && value > property.max) {
      throw new RangeError(`"${property.publicName}" must be at most ${property.max}`);
    }
  }
}

export function readPublicProperty(project: HorizonProject, name: string): unknown {
  const property = project.publicContract.properties[name];
  if (!property?.read) throw new Error(`Public property is not readable: ${name}`);
  const value = getProperty(project, property.target.ownerId, property.target.path);
  if (value === undefined) throw new Error(`Public property target is missing: ${name}`);
  return structuredClone(value);
}

export function writePublicProperties(
  bus: CommandBus,
  values: Record<string, unknown>,
): void {
  const entries = Object.entries(values);
  if (entries.length === 0) return;
  const prepared = entries.map(([name, value]) => {
    const property = bus.project.publicContract.properties[name];
    if (!property?.write) throw new Error(`Public property is not writable: ${name}`);
    validatePublicValue(property, value);
    const previous = getProperty(bus.project, property.target.ownerId, property.target.path);
    if (previous === undefined) throw new Error(`Public property target is missing: ${name}`);
    return { property, value: structuredClone(value), previous };
  });
  const txId = createId('transaction');
  const result = bus.executeTransaction(
    prepared.map(({ property, value, previous }) =>
      buildSetPropertyCommand(
        property.target.ownerId,
        property.target.path,
        value,
        previous,
        txId,
        { kind: 'system' },
        `Runtime update ${entries.map(([name]) => name).join(', ')}`,
        'runtime',
      ),
    ),
    { kind: 'system' },
    `Runtime update ${entries.map(([name]) => name).join(', ')}`,
    'runtime',
  );
  if (!result.ok) throw new Error(result.error);
}

export function resolvePublicTimeline(project: HorizonProject, name: string): Sequence {
  if (!project.publicContract.timelines.includes(name)) {
    throw new Error(`Timeline is not public: ${name}`);
  }
  const sequence =
    project.sequences[name] ??
    Object.values(project.sequences).find((candidate) => candidate.name === name);
  if (!sequence) throw new Error(`Public timeline target is missing: ${name}`);
  return sequence;
}

export function assertPublicEvent(project: HorizonProject, name: string): void {
  if (!project.publicContract.events.includes(name)) {
    throw new Error(`Event is not public: ${name}`);
  }
}
