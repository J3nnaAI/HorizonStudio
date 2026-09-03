/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { EnvironmentSettings, HorizonProject } from './types';
import {
  builtInRenderPresets,
  environmentDefaults,
  renderSettingsDefaults,
} from './project';

const STORAGE_KEY = 'horizon-studio-project';

export const CURRENT_SCHEMA_VERSION = '2.0';

export class ProjectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(
  value: unknown,
  path: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new ProjectValidationError(`${path} must be an object`);
}

function requireString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProjectValidationError(`${path} must be a non-empty string`);
  }
}

interface Migration {
  from: string;
  to: string;
  migrate: (raw: Record<string, unknown>) => Record<string, unknown>;
}

/** 1.0 -> 2.0: legacy string backgrounds, missing renderSettings/renderPresets/renderJobs, sparse env. */
const migrate1To2: Migration['migrate'] = (raw) => {
  const project = raw as Record<string, unknown>;

  const compositions =
    (project.compositions as Record<string, Record<string, unknown>>) ?? {};
  for (const composition of Object.values(compositions)) {
    const legacy = composition.environment;
    const defaults = environmentDefaults() as unknown as Record<string, unknown>;
    let next: Record<string, unknown> = defaults;
    if (typeof legacy === 'string') {
      const background = { ...(defaults.background as Record<string, unknown>) };
      background.color = legacy;
      next = { ...defaults, background };
    } else if (legacy && typeof legacy === 'object') {
      next = mergeEnvironment(defaults, legacy as Record<string, unknown>);
    }
    composition.environment = next as unknown as EnvironmentSettings;
  }

  if (!project.renderSettings) project.renderSettings = renderSettingsDefaults();
  if (!project.renderPresets || Object.keys(project.renderPresets as object).length === 0) {
    project.renderPresets = builtInRenderPresets();
  }
  if (!project.renderJobs) project.renderJobs = {};

  const nodes = (project.nodes as Record<string, { properties: Record<string, unknown> }>) ?? {};
  for (const node of Object.values(nodes)) {
    if (!node.properties) continue;
    if (node.properties['camera.focalLength'] !== undefined) {
      if (node.properties['camera.sensorHeight'] === undefined) node.properties['camera.sensorHeight'] = 24;
      if (node.properties['camera.aperture'] === undefined) node.properties['camera.aperture'] = 2.8;
      if (node.properties['camera.focus'] === undefined) node.properties['camera.focus'] = 5;
      if (node.properties['camera.depthOfField'] === undefined) node.properties['camera.depthOfField'] = false;
      if (node.properties['camera.maxBlur'] === undefined) node.properties['camera.maxBlur'] = 0.008;
      if (node.properties['camera.shutterAngle'] === undefined) node.properties['camera.shutterAngle'] = 180;
      if (node.properties['camera.iso'] === undefined) node.properties['camera.iso'] = 200;
    }
  }

  project.schemaVersion = '2.0';
  return project;
};

function mergeEnvironment(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const existing = merged[key];
    if (
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      merged[key] = { ...(existing as Record<string, unknown>), ...(value as Record<string, unknown>) };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

const migrations: Migration[] = [{ from: '1.0', to: '2.0', migrate: migrate1To2 }];

function hasMigrationPath(fromVersion: string): boolean {
  let version = fromVersion;
  const visited = new Set<string>();
  while (version !== CURRENT_SCHEMA_VERSION && !visited.has(version)) {
    visited.add(version);
    const migration = migrations.find((candidate) => candidate.from === version);
    if (!migration) return false;
    version = migration.to;
  }
  return version === CURRENT_SCHEMA_VERSION;
}

/**
 * Validates the durable project envelope. Domain objects remain extensible, but
 * the canonical maps and active composition must be present and coherent.
 */
export function validateProject(project: unknown): asserts project is HorizonProject {
  requireRecord(project, 'project');
  requireString(project.schemaVersion, 'project.schemaVersion');
  if (project.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new ProjectValidationError(
      `Unsupported project schema ${project.schemaVersion}; expected ${CURRENT_SCHEMA_VERSION}`,
    );
  }
  requireString(project.projectId, 'project.projectId');
  requireString(project.name, 'project.name');
  requireString(project.activeCompositionId, 'project.activeCompositionId');

  const recordFields = [
    'assets',
    'compositions',
    'nodes',
    'materials',
    'shaders',
    'fields',
    'sequences',
    'tracks',
    'behaviors',
    'renderPresets',
    'renderJobs',
    'renderSettings',
    'variants',
    'metadata',
  ] as const;
  for (const field of recordFields) requireRecord(project[field], `project.${field}`);
  const compositions = project.compositions as Record<string, unknown>;
  if (!(project.activeCompositionId in compositions)) {
    throw new ProjectValidationError(
      `Active composition ${project.activeCompositionId} does not exist`,
    );
  }

  requireRecord(project.publicContract, 'project.publicContract');
  requireRecord(project.publicContract.properties, 'project.publicContract.properties');
  if (!Array.isArray(project.publicContract.timelines)) {
    throw new ProjectValidationError('project.publicContract.timelines must be an array');
  }
  if (!Array.isArray(project.publicContract.events)) {
    throw new ProjectValidationError('project.publicContract.events must be an array');
  }
}

export interface MigrationReport {
  migrated: boolean;
  fromVersion: string;
  toVersion: string;
  steps: Array<{ from: string; to: string }>;
  warnings: string[];
}

export function migrateProject(raw: Record<string, unknown>): {
  project: HorizonProject;
  report: MigrationReport;
} {
  const initial = String(raw.schemaVersion ?? '1.0');
  const warnings: string[] = [];
  const steps: MigrationReport['steps'] = [];
  let cursor = raw;
  let version = initial;
  let safety = 32;
  while (version !== CURRENT_SCHEMA_VERSION && safety-- > 0) {
    const next = migrations.find((m) => m.from === version);
    if (!next) {
      warnings.push(`No migration from ${version}`);
      break;
    }
    cursor = next.migrate(cursor);
    steps.push({ from: next.from, to: next.to });
    version = next.to;
  }
  return {
    project: cursor as unknown as HorizonProject,
    report: {
      migrated: steps.length > 0,
      fromVersion: initial,
      toVersion: version,
      steps,
      warnings,
    },
  };
}

export function serializeProject(project: HorizonProject): string {
  return JSON.stringify(project, null, 2);
}

export function deserializeProject(json: string): {
  project: HorizonProject;
  report: MigrationReport;
} {
  const parsed: unknown = JSON.parse(json);
  requireRecord(parsed, 'project');
  const initialVersion = String(parsed.schemaVersion ?? '1.0');
  if (!hasMigrationPath(initialVersion)) {
    throw new ProjectValidationError(
      `Unsupported project schema ${initialVersion}; current schema is ${CURRENT_SCHEMA_VERSION}`,
    );
  }
  const result = migrateProject(parsed);
  validateProject(result.project);
  return result;
}

export function saveProjectLocal(project: HorizonProject): void {
  localStorage.setItem(STORAGE_KEY, serializeProject(project));
}

export function clearProjectLocal(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function loadProjectLocal(): {
  project: HorizonProject;
  report: MigrationReport;
} | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return deserializeProject(raw);
  } catch {
    return null;
  }
}

export function exportProjectBlob(project: HorizonProject): Blob {
  return new Blob([serializeProject(project)], { type: 'application/json' });
}

export interface PublishManifest {
  schemaVersion: string;
  projectId: string;
  name: string;
  compositionId: string;
  properties: Record<string, unknown>;
  timelines: string[];
  events: string[];
  renderPresets: string[];
}

export function preparePublish(project: HorizonProject): {
  manifest: PublishManifest;
  composition: HorizonProject;
  warnings: string[];
} {
  const comp = project.compositions[project.activeCompositionId];
  const warnings: string[] = [];
  const publicProps: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(project.publicContract.properties)) {
    publicProps[name] = {
      type: prop.type,
      read: prop.read,
      write: prop.write,
      min: prop.min,
      max: prop.max,
    };
  }
  if (Object.keys(publicProps).length === 0) {
    warnings.push('No public properties exposed');
  }
  return {
    manifest: {
      schemaVersion: project.schemaVersion,
      projectId: project.projectId,
      name: project.name,
      compositionId: comp.id,
      properties: publicProps,
      timelines: project.publicContract.timelines,
      events: project.publicContract.events,
      renderPresets: Object.keys(project.renderPresets ?? {}),
    },
    composition: structuredClone(project),
    warnings,
  };
}
