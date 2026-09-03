/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import type { HorizonProject, MaterialDef, ShaderDef } from '../core/types';
import { ensureBuiltinShaders } from '../shaders';
import { resolveAssetUrl } from '../assets/importers';
import {
  FLOOR_SHADER_ID,
  GRAPHITE_SHADER_ID,
  IMAGE_SHADER_ID,
  PHYSICAL_SHADER_ID,
} from '../shaders';
import {
  compileShaderDefinitionGraph,
  createThreeMaterialFromGraph,
  getShaderGraph,
  updateThreeMaterialFromGraph,
  validateTextureBindings,
} from '../shaders';
import {
  createCustomThreeMaterial,
  ensureCustomShadersCompiled,
  getCompiledCustomShader,
  updateCustomThreeMaterial,
} from '../shaders/customShaderRuntime';

export interface CompiledMaterial {
  material: THREE.Material;
  excludeFromBloom: boolean;
  dispose: () => void;
}

export class MaterialCompiler {
  private cache = new Map<string, CompiledMaterial>();
  private textures = new Map<string, THREE.Texture>();
  private grain: THREE.CanvasTexture;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.grain = this.createGrainTexture(256, 4.5, 0.32);
  }

  ensureProjectShaders(project: HorizonProject): void {
    ensureBuiltinShaders(project.shaders);
  }

  compile(project: HorizonProject, definition: MaterialDef): CompiledMaterial {
    const shader = project.shaders[definition.shaderId];
    if (shader?.kind === 'custom-js') ensureCustomShadersCompiled(project.shaders);
    const cached = this.cache.get(definition.id);
    if (cached) {
      const graph = shader ? getShaderGraph(shader) : undefined;
      if (graph) {
        const candidate = compileShaderDefinitionGraph(shader);
        const activeKey = candidate.program?.cacheKey;
        if (activeKey && cached.material.userData.shaderProgramCacheKey !== activeKey) {
          cached.dispose();
          const rebuilt = this.build(project, definition, shader);
          this.cache.set(definition.id, rebuilt);
          return rebuilt;
        }
      } else if (shader?.kind === 'custom-js') {
        const revision = getCompiledCustomShader(shader.id)?.revision;
        if (revision && cached.material.userData.customShaderRevision !== revision) {
          cached.dispose();
          const rebuilt = this.build(project, definition, shader);
          this.cache.set(definition.id, rebuilt);
          return rebuilt;
        }
      }
      this.update(project, definition, cached);
      return cached;
    }
    const compiled = this.build(project, definition, shader);
    this.cache.set(definition.id, compiled);
    return compiled;
  }

  private build(
    project: HorizonProject,
    definition: MaterialDef,
    shader?: ShaderDef,
  ): CompiledMaterial {
    const params = definition.parameters;
    const shaderId = definition.shaderId;
    let material: THREE.Material;
    let excludeFromBloom = params.bloom !== true;

    const graph = shader ? getShaderGraph(shader) : undefined;
    if (graph && shader) {
      const result = compileShaderDefinitionGraph(shader);
      if (
        result.program &&
        (result.program.domain === 'surface' ||
          result.program.domain === 'vertex' ||
          result.program.domain === 'deformation')
      ) {
        material = createThreeMaterialFromGraph(result.program, params);
        material.userData.shaderProgramCacheKey = result.program.cacheKey;
        material.userData.shaderDiagnostics = result.diagnostics;
        material.userData.usingLastKnownGood = result.usingLastKnownGood;
      } else {
        const fallback = new THREE.MeshPhysicalMaterial();
        this.applyPhysicalParams(fallback, params);
        fallback.userData.shaderDiagnostics = result.diagnostics;
        material = fallback;
      }
    } else if (shader?.kind === 'custom-js') {
      ensureCustomShadersCompiled(project.shaders);
      const result = createCustomThreeMaterial(shaderId, params);
      material = result.material;
      material.userData.customShaderRevision = getCompiledCustomShader(shaderId)?.revision;
      material.userData.shaderDiagnostics = result.diagnostics;
      material.userData.usingLastKnownGood = result.usedLastKnownGood;
    } else if (shaderId === GRAPHITE_SHADER_ID) {
      material = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color((params.baseTone as string) ?? '#08090a'),
        metalness: (params.metallic as number) ?? 0.97,
        roughness: (params.roughness as number) ?? 0.32,
        envMapIntensity: 0.7 + ((params.edgeEnergy as number) ?? 0.45) * 0.65,
        bumpMap: this.grain,
        bumpScale: (params.bumpScale as number) ?? 0.012,
        clearcoat: (params.clearcoat as number) ?? 0.16,
        clearcoatRoughness: (params.clearcoatRoughness as number) ?? 0.16,
        anisotropy: (params.anisotropy as number) ?? 0.34,
        anisotropyRotation: (params.anisotropyRotation as number) ?? Math.PI / 2,
      });
      excludeFromBloom = params.bloom !== true;
    } else if (shaderId === FLOOR_SHADER_ID) {
      material = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color((params.baseColor as string) ?? '#0b0c0d'),
        metalness: 0.06,
        roughness: (params.roughness as number) ?? 0.72,
        envMapIntensity: 0.015,
        bumpMap: this.grain,
        bumpScale: 0.003,
        clearcoat: 0.03,
        clearcoatRoughness: 0.8,
      });
      excludeFromBloom = true;
    } else if (shaderId === IMAGE_SHADER_ID) {
      material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        metalness: (params.metalness as number) ?? 0,
        roughness: (params.roughness as number) ?? 0.78,
        transparent: true,
        opacity: (params.opacity as number) ?? 1,
        side: params.doubleSided === false ? THREE.FrontSide : THREE.DoubleSide,
        toneMapped: params.toneMapped !== false,
        depthWrite: params.depthWrite !== false,
      });
      excludeFromBloom = params.bloom !== true;
      void this.bindImageTexture(project, definition, material as THREE.MeshStandardMaterial);
    } else {
      material = new THREE.MeshPhysicalMaterial();
      this.applyPhysicalParams(material as THREE.MeshPhysicalMaterial, params);
      excludeFromBloom = params.bloom !== true;
    }

    this.applyTextureSlots(project, definition, shader, material);
    material.userData.excludeFromBloom = excludeFromBloom;
    material.userData.shaderId = shaderId;

    return {
      material,
      excludeFromBloom,
      dispose: () => {
        material.dispose();
        this.cache.delete(definition.id);
      },
    };
  }

  private update(project: HorizonProject, definition: MaterialDef, compiled: CompiledMaterial): void {
    const params = definition.parameters;
    const shader = project.shaders[definition.shaderId];
    const graph = shader ? getShaderGraph(shader) : undefined;
    if (graph && compiled.material instanceof THREE.ShaderMaterial) {
      const result = compileShaderDefinitionGraph(shader);
      if (result.program) {
        updateThreeMaterialFromGraph(compiled.material, result.program, params);
        compiled.material.userData.shaderDiagnostics = result.diagnostics;
        compiled.material.userData.usingLastKnownGood = result.usingLastKnownGood;
      }
    } else if (shader?.kind === 'custom-js') {
      const updated = updateCustomThreeMaterial(shader.id, compiled.material, params);
      if (!updated && compiled.material instanceof THREE.MeshPhysicalMaterial) {
        this.applyPhysicalParams(compiled.material, params);
      }
    } else if (compiled.material instanceof THREE.MeshPhysicalMaterial) {
      this.applyPhysicalParams(compiled.material, params);
    } else if (compiled.material instanceof THREE.MeshStandardMaterial) {
      compiled.material.opacity = (params.opacity as number) ?? 1;
      compiled.material.roughness = (params.roughness as number) ?? 0.78;
      void this.bindImageTexture(project, definition, compiled.material);
    }
    compiled.excludeFromBloom = params.bloom !== true;
    compiled.material.userData.excludeFromBloom = compiled.excludeFromBloom;
  }

  private applyPhysicalParams(material: THREE.MeshPhysicalMaterial, params: Record<string, unknown>): void {
    material.color.set((params.baseColor as string) ?? '#808080');
    material.metalness = (params.metalness as number) ?? 0;
    material.roughness = (params.roughness as number) ?? 0.5;
    material.emissive.set((params.emissiveColor as string) ?? '#000000');
    material.emissiveIntensity = (params.emissiveIntensity as number) ?? 0;
    material.clearcoat = (params.clearcoat as number) ?? 0;
    material.clearcoatRoughness = (params.clearcoatRoughness as number) ?? 0;
    material.sheen = (params.sheen as number) ?? 0;
    material.sheenColor.set((params.sheenColor as string) ?? '#ffffff');
    material.anisotropy = (params.anisotropy as number) ?? 0;
    material.transmission = (params.transmission as number) ?? 0;
    material.thickness = (params.thickness as number) ?? 0;
    material.ior = (params.ior as number) ?? 1.5;
    material.envMapIntensity = (params.envMapIntensity as number) ?? 1;
    material.opacity = (params.opacity as number) ?? 1;
    material.transparent = material.opacity < 1 || material.transmission > 0;
    material.side = params.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
    material.needsUpdate = true;
  }

  private async bindImageTexture(
    project: HorizonProject,
    definition: MaterialDef,
    material: THREE.MeshStandardMaterial,
  ): Promise<void> {
    const assetId = definition.parameters.assetId as string;
    if (!assetId) return;
    const asset = project.assets[assetId] as import('../core/types').AssetRecord | undefined;
    if (!asset) return;
    const url = await resolveAssetUrl(asset);
    if (!url) return;
    let texture = this.textures.get(assetId);
    if (!texture) {
      texture = await new THREE.TextureLoader().loadAsync(url);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      this.textures.set(assetId, texture);
    }
    material.map = texture;
    material.needsUpdate = true;
  }

  private applyTextureSlots(
    project: HorizonProject,
    definition: MaterialDef,
    shader: ShaderDef | undefined,
    material: THREE.Material,
  ): void {
    if (!shader?.textureSlots || !definition.textures) return;
    const validation = validateTextureBindings(shader, definition, project.assets, {
      maxAnisotropy: this.renderer.capabilities.getMaxAnisotropy(),
      maxTextureSize: this.renderer.capabilities.maxTextureSize,
    });
    material.userData.textureBindingDiagnostics = validation.diagnostics;
    for (const slot of shader.textureSlots) {
      const binding = validation.accepted[slot.slot];
      if (!binding?.assetId) continue;
      const asset = project.assets[binding.assetId] as import('../core/types').AssetRecord | undefined;
      if (!asset) continue;
      void resolveAssetUrl(asset).then(async (url) => {
        if (!url || !(material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshPhysicalMaterial)) return;
        const texture = await new THREE.TextureLoader().loadAsync(url);
        texture.colorSpace = slot.colorSpace === 'sRGB' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        if (binding.anisotropy) texture.anisotropy = binding.anisotropy;
        if (binding.scale) texture.repeat.set(binding.scale[0], binding.scale[1]);
        if (binding.offset) texture.offset.set(binding.offset[0], binding.offset[1]);
        if (binding.rotation) texture.rotation = binding.rotation;
        texture.wrapS =
          binding.wrapU === 'repeat'
            ? THREE.RepeatWrapping
            : binding.wrapU === 'mirror'
              ? THREE.MirroredRepeatWrapping
              : THREE.ClampToEdgeWrapping;
        texture.wrapT =
          binding.wrapV === 'repeat'
            ? THREE.RepeatWrapping
            : binding.wrapV === 'mirror'
              ? THREE.MirroredRepeatWrapping
              : THREE.ClampToEdgeWrapping;
        texture.minFilter =
          binding.minFilter === 'nearest'
            ? THREE.NearestFilter
            : binding.minFilter === 'linear'
              ? THREE.LinearFilter
              : binding.minFilter === 'linearMipNearest'
                ? THREE.LinearMipmapNearestFilter
                : THREE.LinearMipmapLinearFilter;
        texture.magFilter =
          binding.magFilter === 'nearest' ? THREE.NearestFilter : THREE.LinearFilter;
        texture.channel = binding.uvChannel ?? slot.uvChannel;
        texture.flipY = binding.flipY ?? texture.flipY;
        texture.userData.channel = binding.channel ?? slot.channel;
        texture.needsUpdate = true;
        switch (slot.role) {
          case 'baseColor':
            material.map = texture;
            break;
          case 'roughness':
            if (material instanceof THREE.MeshPhysicalMaterial) material.roughnessMap = texture;
            break;
          case 'metallic':
            if (material instanceof THREE.MeshPhysicalMaterial) material.metalnessMap = texture;
            break;
          case 'normal':
            material.normalMap = texture;
            break;
          case 'bump':
            material.bumpMap = texture;
            break;
          case 'ambientOcclusion':
            material.aoMap = texture;
            break;
          case 'emissive':
            material.emissiveMap = texture;
            break;
          case 'opacity':
            material.alphaMap = texture;
            material.transparent = true;
            break;
          case 'displacement':
            material.displacementMap = texture;
            break;
          case 'clearcoat':
            if (material instanceof THREE.MeshPhysicalMaterial) material.clearcoatMap = texture;
            break;
          case 'clearcoatRoughness':
            if (material instanceof THREE.MeshPhysicalMaterial) {
              material.clearcoatRoughnessMap = texture;
            }
            break;
          case 'clearcoatNormal':
            if (material instanceof THREE.MeshPhysicalMaterial) material.clearcoatNormalMap = texture;
            break;
          case 'transmission':
            if (material instanceof THREE.MeshPhysicalMaterial) material.transmissionMap = texture;
            break;
          case 'thickness':
            if (material instanceof THREE.MeshPhysicalMaterial) material.thicknessMap = texture;
            break;
          case 'sheen':
            if (material instanceof THREE.MeshPhysicalMaterial) material.sheenColorMap = texture;
            break;
          case 'anisotropy':
            if (material instanceof THREE.MeshPhysicalMaterial) material.anisotropyMap = texture;
            break;
          default:
            break;
        }
        material.needsUpdate = true;
      });
    }
  }

  private createGrainTexture(size: number, frequency: number, contrast: number): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d')!;
    const image = context.createImageData(size, size);
    const data = image.data;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const index = (y * size + x) * 4;
        const random = (Math.random() - 0.5) * contrast;
        const value = Math.round(128 + random * 110);
        data[index] = data[index + 1] = data[index + 2] = value;
        data[index + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.NoColorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  dispose(): void {
    for (const compiled of this.cache.values()) compiled.dispose();
    this.cache.clear();
    for (const texture of this.textures.values()) texture.dispose();
    this.textures.clear();
    this.grain.dispose();
  }
}
