/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { AssetRecord } from '../core/types';
import { importModelAsset, resolveAssetUrl, type ImportResult } from './importers';

export interface GltfMaterialSlot {
  index: number;
  name: string;
  meshName: string;
}

export interface GltfInspection {
  materialSlots: GltfMaterialSlot[];
  animations: string[];
  nodeCount: number;
}

function inspect(gltf: GLTF): GltfInspection {
  const materialSlots: GltfMaterialSlot[] = [];
  let nodeCount = 0;
  gltf.scene.traverse((object) => {
    nodeCount++;
    if (!(object as THREE.Mesh).isMesh) return;
    const mesh = object as THREE.Mesh;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((material, index) => {
      materialSlots.push({
        index,
        name: material.name || `${mesh.name || 'Mesh'} Material ${index + 1}`,
        meshName: mesh.name || object.uuid,
      });
    });
  });
  return {
    materialSlots,
    animations: gltf.animations.map((animation) => animation.name).filter(Boolean),
    nodeCount,
  };
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      material.dispose();
    }
  });
}

export async function inspectGltfBlob(blob: Blob): Promise<GltfInspection> {
  const loader = new GLTFLoader();
  const buffer = await blob.arrayBuffer();
  const gltf = await new Promise<GLTF>((resolve, reject) => {
    loader.parse(buffer, '', resolve, reject);
  });
  try {
    return inspect(gltf);
  } finally {
    disposeObject(gltf.scene);
  }
}

export async function importGltfAsset(
  blob: Blob,
  name: string,
  source = 'import',
): Promise<ImportResult & { inspection: GltfInspection }> {
  const inspection = await inspectGltfBlob(blob);
  const result = await importModelAsset(blob, name, source);
  result.asset.metadata = {
    ...result.asset.metadata,
    gltf: inspection,
  };
  return { ...result, inspection };
}

/**
 * Loads and caches canonical glTF scenes by content hash/blob key. Consumers
 * receive deep clones so scene-level transforms and material assignment remain
 * independent.
 */
export class GltfAssetLoader {
  private loader = new GLTFLoader();
  private cache = new Map<string, Promise<GLTF>>();

  async instantiate(asset: AssetRecord): Promise<{ object: THREE.Object3D; inspection: GltfInspection }> {
    const key = asset.hash || asset.blobKey || asset.url || asset.id;
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.load(asset);
      this.cache.set(key, pending);
      pending.catch(() => this.cache.delete(key));
    }
    const gltf = await pending;
    return {
      object: cloneSkeleton(gltf.scene),
      inspection: inspect(gltf),
    };
  }

  private async load(asset: AssetRecord): Promise<GLTF> {
    const url = await resolveAssetUrl(asset);
    if (!url) throw new Error(`Model data is unavailable: ${asset.name}`);
    try {
      return await this.loader.loadAsync(url);
    } finally {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    }
  }

  dispose(): void {
    for (const pending of this.cache.values()) {
      void pending.then((gltf) => disposeObject(gltf.scene));
    }
    this.cache.clear();
  }
}
