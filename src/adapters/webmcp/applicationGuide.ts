/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebMcpContext, WebMcpPermissions } from './tools';
import { PUBLIC_PROJECT_TOOL_NAMES } from './projectTools';

const PUBLIC_TOOLS = [
  'about',
  ...PUBLIC_PROJECT_TOOL_NAMES,
  'listComponents',
  'findComponents',
  'inspectComponent',
  'selectedComponent',
  'selectComponent',
  'updateComponent',
  'removeComponent',
] as const;

function currentPermissions(ctx: WebMcpContext): Required<WebMcpPermissions> {
  return {
    delete: false,
    import: false,
    remoteImport: false,
    save: false,
    export: false,
    publish: false,
    trustedShaderSource: false,
    ...ctx.permissions,
  };
}

export function buildApplicationGuide(ctx: WebMcpContext): Record<string, unknown> {
  return {
    guideVersion: '1.0.0',
    application: {
      name: 'Horizon Studio',
      summary:
        'Horizon Studio is a browser-based editor for interactive 3D scenes, motion graphics, presentations, and published web experiences.',
      model:
        'One canonical HorizonProject stores scene nodes, materials, shaders, fields, timelines, interactions, responsive variants, render settings, and the public runtime contract.',
      mutationRule:
        'All persistent MCP edits use attributed CommandBus transactions. This keeps MCP edits compatible with validation, revision checks, undo, redo, and human edits.',
    },
    recommendedFirstCall: {
      tool: 'about',
      input: {},
      reason: 'This call returns the application model, current permissions, tool contracts, and task workflows.',
    },
    guideEndpoint: {
      tool: 'inspectComponent',
      input: { componentId: 'action/application-guide' },
      note: 'This is the component-native form of about. Inspect it again when the project revision or permission policy changes.',
    },
    currentSession: {
      schemaVersion: ctx.bus.project.schemaVersion,
      revision: ctx.bus.getRevision(),
      projectId: ctx.bus.project.projectId,
      projectName: ctx.bus.project.name,
      selection: ctx.getSelection(),
      permissions: currentPermissions(ctx),
      renderer: ctx.scene.getCapabilities?.() ?? null,
      renderQueueConnected: Boolean(ctx.renderQueue),
    },
    capabilities: [
      'Inspect and edit project, composition, scene, node, material, shader, field, timeline, interaction, presentation, responsive, runtime-contract, and render state.',
      'Create, list, open, import, save, export, publish, and preview projects through explicit project tools backed entirely by browser storage and downloads.',
      'Create supported entities through factory components such as factory/node, factory/material, factory/sequence, and factory/render-job.',
      'Invoke higher-level authoring operations through action components such as action/object-transform and action/preview-render.',
      'Select scene components and inspect every editable value with its type, range, help, and validation rules.',
      'Inspect global history and invoke guarded undo or redo actions.',
      'Publish a base-path-safe static runtime and queue deterministic still, sequence, or video renders when policy permits.',
      'Discover the same versioned project-template and effect catalogs shown to the human in Project Hub.',
    ],
    concepts: {
      component:
        'A component is an addressable entity, value, factory, or action. Its descriptor contains currentValue, dataType, componentType, help, ranges, mutability, and validation details.',
      componentId:
        'Component IDs use kind/owner/path. Examples: entity-node/node_123, property/node_123/camera.focalLength, factory/node, and action/object-transform.',
      discovery:
        'Use listComponents for pages of components. Use findComponents when you know a name, owner, kind, type, scope, or capability.',
      factories:
        'Call updateComponent on a factory component with operation create, append, or upsert.',
      actions:
        'Inspect read-only action components to get live reports. Call updateComponent with operation invoke for actions that perform work.',
      revisions:
        'Read the revision in every response. Send expectedRevision for edits. Inspect again and retry when a call returns STALE_REVISION.',
      permissions:
        'Descriptors state required permissions and confirmations. The application rejects an operation when the current policy does not grant it.',
      validation:
        'Read validationFunction and validationRules before an edit. A failed validation does not change the project.',
      history:
        'Undo and redo traverse the shared global history. Inspect action/history-recent first. Pass both the current revision and the exact candidate transaction ID so an agent cannot undo a newer human edit by accident.',
      pagination:
        'listComponents and findComponents return pagination.nextCursor. Pass it as cursor to request the next page.',
      catalogs:
        'Find catalog-template and catalog-effect components to recommend starting points using the same names, descriptions, requirements, and fallbacks visible in the Studio.',
    },
    projectEditOperations: {
      references: 'Give any create operation a ref such as heroCamera. Later values may use @heroCamera; Horizon resolves it to the generated stable ID before validation.',
      setProject: '{ op, name?, activeCompositionId? }',
      setMetadata: '{ op, path, value }; webmcpPermissions is protected from self-escalation',
      setPresentation: '{ op, value:{ slides, autoplay, intervalSeconds, loop, clickToAdvance } }',
      setPublicContract: '{ op, value:{ properties, timelines, events } }',
      patchEntity: '{ op, collection, entityId, patch }; supports assets, nodes, shaders, materials, compositions, sequences, tracks, behaviors, and variants',
      moveNode: '{ op, nodeId, parentId? or compositionId?, index? }',
      createAsset: '{ op, ref?, id?, value:{ name, kind, mimeType, storage?, dataUrl? or url?, metadata? } }',
      createNode: '{ op, ref?, id?, value:{ type, name, compositionId?, parentId?, properties?, components?, tags? } }',
      createShader: '{ op, ref?, id?, value:{ name, kind, domain, parameters, graph? } }',
      createMaterial: '{ op, ref?, id?, value:{ name, shaderId, parameters, textures? } }',
      createComposition: '{ op, ref?, id?, value:{ name, rootNodes?, activeCamera?, sequence?, environment?, inherits?, nodeOverrides? } }',
      createSequence: '{ op, ref?, id?, value:{ name, duration, nominalFps, tracks?, markers?, defaultDriver?, experience?, videoCameras?, cameraCuts? } }',
      createTrack: '{ op, ref?, id?, value:{ sequenceId, name, kind?, target, keyframes?, clips?, events?, enabled? } }',
      addClip: '{ op, ref?, id?, trackId, value:{ kind, start, duration, ...clip fields } }',
      addMarker: '{ op, ref?, id?, sequenceId, value:{ time, name, public? } }',
      addBehavior: '{ op, ref?, id?, value:{ name, trigger, actions, enabled? } }',
      setProperty: '{ op, ownerId, path, value }',
    },
    tools: {
      about: {
        purpose: 'Explain Horizon Studio, report current capabilities, and show how to use every public tool.',
        readOnly: true,
        input: {},
        result: 'This guide. MCP clients should call about first.',
      },
      newProject: {
        purpose: 'Create and open a blank project or a project from a built-in template.',
        readOnly: false,
        input: { name: 'optional project name', templateId: 'optional catalog template ID', expectedRevision: 'required current revision' },
        result: 'The new project ID, name, template ID, and revision.',
      },
      listProjects: {
        purpose: 'List projects saved in this browser.',
        readOnly: true,
        input: {},
        result: 'Project IDs, names, schema versions, revisions, and timestamps.',
      },
      openProject: {
        purpose: 'Open a browser-saved project by ID.',
        readOnly: false,
        input: { projectId: 'required saved project ID', expectedRevision: 'required current revision' },
        result: 'The opened project ID, name, and recovery information.',
      },
      editProject: {
        purpose: 'Apply a complete cross-entity authoring plan as one validated and undoable transaction.',
        readOnly: false,
        input: {
          operations: '1-2000 ordered edit objects; use ref on creates and @ref anywhere later in the batch',
          expectedRevision: 'required current revision',
          intent: 'plain-language description recorded in shared history',
        },
        result: 'One transaction ID, the new revision, and a map from client references to created entity IDs.',
      },
      importProject: {
        purpose: 'Import and open a portable .hzn package without repository access.',
        readOnly: false,
        input: { dataUrl: 'inline package data URL', url: 'allowed same-origin or policy-approved URL', expectedRevision: 'required current revision' },
        result: 'The imported project ID, name, and package warnings.',
      },
      saveProject: {
        purpose: 'Save the current project to durable browser storage.',
        readOnly: false,
        input: { expectedRevision: 'required current revision' },
        result: 'The saved project and browser-storage revision.',
      },
      exportProject: {
        purpose: 'Download the editable project as a portable .hzn package.',
        readOnly: false,
        input: { expectedRevision: 'required current revision' },
        result: 'The downloaded filename, MIME type, and size.',
      },
      publishProject: {
        purpose: 'Download a base-path-safe static website for GitHub Pages or any static host.',
        readOnly: false,
        input: { expectedRevision: 'required current revision' },
        result: 'The published filename, MIME type, size, and diagnostics.',
      },
      previewProject: {
        purpose: 'Open the current project runtime in a separate browser tab.',
        readOnly: false,
        input: { sequenceId: 'optional sequence ID' },
        result: 'The previewed project and sequence IDs.',
      },
      listComponents: {
        purpose: 'List component descriptors and return the current capability and permission summary.',
        readOnly: true,
        input: {
          query: 'optional text',
          kind: 'optional component kind',
          componentType: 'optional component type',
          ownerId: 'optional owner ID',
          registryScope: 'optional registry scope',
          mutable: 'optional boolean',
          animatable: 'optional boolean',
          limit: 'optional integer from 1 to 200; default 50',
          cursor: 'optional cursor from the previous page',
          offset: 'optional numeric offset when no cursor is used',
        },
        result: 'Full descriptors, pagination, supported kinds and operations, permissions, and the guide component ID.',
      },
      findComponents: {
        purpose: 'Search component descriptors by text and metadata.',
        readOnly: true,
        input: 'The listComponents filters. Supply query for text search.',
        result: 'A paginated set of full component descriptors.',
      },
      inspectComponent: {
        purpose: 'Return one full descriptor. Inspection actions return a live report in currentValue.',
        readOnly: true,
        input: {
          componentId: 'required component ID',
          value: 'optional parameters for an inspection action, such as sequenceId, compositionId, jobId, or history limit',
        },
        result: 'One full descriptor with currentValue and validation details.',
      },
      selectedComponent: {
        purpose: 'Return selected scene nodes and all related component descriptors.',
        readOnly: true,
        input: {},
        result: 'Selected node IDs and rich descriptors.',
      },
      selectComponent: {
        purpose: 'Change the editor selection.',
        readOnly: false,
        input: {
          componentIds: 'component IDs; omit only for clear mode',
          mode: 'replace, add, remove, or clear',
        },
        result: 'The new selection.',
      },
      updateComponent: {
        purpose: 'Create, update, upsert, append, or invoke a component through its safe mutation route.',
        readOnly: false,
        input: {
          componentId: 'required component, factory, or action ID',
          operation: 'create, append, upsert, update, or invoke',
          value: 'new value or operation input',
          patch: 'optional object patch',
          properties: 'optional atomic property batch',
          expectedRevision: 'current project revision',
          intent: 'short description recorded in history',
        },
        result: 'Transaction ID, changed component IDs, new revision, warnings, and operation data.',
      },
      removeComponent: {
        purpose: 'Remove a deletable component through an undoable transaction.',
        readOnly: false,
        input: {
          componentId: 'required component ID',
          expectedRevision: 'required current project revision',
          intent: 'short description recorded in history',
        },
        result: 'Transaction ID, changed IDs, and new revision.',
      },
    },
    workflows: [
      {
        task: 'Change a camera setting',
        calls: [
          { tool: 'findComponents', input: { query: 'focal length', componentType: 'camera' }, save: 'component.id and revision' },
          { tool: 'inspectComponent', input: { componentId: '<component.id>' }, check: 'dataType, rangeMin, rangeMax, and validationRules' },
          { tool: 'updateComponent', input: { componentId: '<component.id>', operation: 'update', value: 55, expectedRevision: '<revision>', intent: 'Set camera focal length' } },
        ],
      },
      {
        task: 'Create and configure a scene node',
        calls: [
          { tool: 'inspectComponent', input: { componentId: 'factory/node' }, check: 'factory input help and validationRules' },
          { tool: 'updateComponent', input: { componentId: 'factory/node', operation: 'create', value: { type: 'mesh', name: 'Product' }, expectedRevision: '<revision>', intent: 'Create product mesh' }, save: 'created node ID and new revision' },
          { tool: 'findComponents', input: { ownerId: '<created node ID>', mutable: true }, save: 'editable node components' },
          { tool: 'updateComponent', input: { componentId: 'property/<created node ID>/transform.position', value: [0, 1, 0], expectedRevision: '<new revision>', intent: 'Place product mesh' } },
        ],
      },
      {
        task: 'Create animation',
        calls: [
          { tool: 'updateComponent', input: { componentId: 'factory/sequence', operation: 'create', value: { name: 'Intro', duration: 5, fps: 60 }, expectedRevision: '<revision>' }, save: 'sequence ID and revision' },
          { tool: 'updateComponent', input: { componentId: 'factory/track', operation: 'create', value: { sequenceId: '<sequence ID>', name: 'Camera Move', kind: 'property', ownerId: '<camera ID>', path: 'transform.position' }, expectedRevision: '<revision>' }, save: 'track ID and revision' },
          { tool: 'updateComponent', input: { componentId: 'factory/keyframe', operation: 'create', value: { trackId: '<track ID>', keyframe: { time: 0, value: [0, 1, 8], interpolation: 'cubic' } }, expectedRevision: '<revision>' } },
        ],
      },
      {
        task: 'Render with a preset',
        calls: [
          { tool: 'findComponents', input: { kind: 'entity-render-preset' }, save: 'preset ID' },
          { tool: 'updateComponent', input: { componentId: 'action/render-enqueue', operation: 'invoke', value: { presetId: '<preset ID>' }, expectedRevision: '<revision>', intent: 'Queue final render' }, save: 'job ID' },
          { tool: 'inspectComponent', input: { componentId: 'action/render-status', value: { jobId: '<job ID>' } }, repeatUntil: 'status is complete, failed, or cancelled' },
        ],
      },
      {
        task: 'Publish a static runtime',
        calls: [
          { tool: 'inspectComponent', input: { componentId: 'action/publish-prepare' }, check: 'diagnostics and required assets' },
          { tool: 'publishProject', input: { expectedRevision: '<revision>' } },
        ],
      },
      {
        task: 'Recover from a stale revision',
        calls: [
          { tool: 'inspectComponent', input: { componentId: '<target component ID>' }, save: 'latest currentValue and revision' },
          { tool: 'updateComponent', input: { componentId: '<target component ID>', value: '<recomputed value>', expectedRevision: '<latest revision>', intent: 'Retry after concurrent edit' } },
        ],
      },
      {
        task: 'Undo and redo safely',
        calls: [
          { tool: 'inspectComponent', input: { componentId: 'action/history-recent' }, save: 'revision and undoCandidate.id' },
          { tool: 'updateComponent', input: { componentId: 'action/history-undo', operation: 'invoke', value: { expectedTransactionId: '<undoCandidate.id>' }, expectedRevision: '<revision>' }, save: 'new revision and redoCandidate.id' },
          { tool: 'updateComponent', input: { componentId: 'action/history-redo', operation: 'invoke', value: { expectedTransactionId: '<redoCandidate.id>' }, expectedRevision: '<new revision>' } },
        ],
      },
    ],
    publicTools: [...PUBLIC_TOOLS],
  };
}
