/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { EvalSnapshot } from '../../core/evaluator';
import type { HorizonNode, HorizonProject } from '../../core/types';
import { resolveAssetUrl } from '../../assets/importers';
import * as THREE from 'three';
import { resolveCompositionRootNodes } from '../../core/project';

const DOM_LAYER_TYPES = new Set(['html', 'svg', 'dynamicText', 'image', 'video', 'audio']);

function mountPackedAlphaDecoder(video: HTMLVideoElement, canvas: HTMLCanvasElement): void {
  const initialize = () => {
    canvas.width = Math.max(1, Math.floor(video.videoWidth / 2));
    canvas.height = Math.max(1, video.videoHeight);
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
    });
    if (!gl) return;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Could not create packed-alpha shader');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) ?? 'Packed-alpha shader compilation failed');
      }
      return shader;
    };
    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, `#version 300 es
      out vec2 vUv;
      void main() {
        vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
        vUv = p;
        gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
      }`));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;
      uniform sampler2D packedFrame;
      in vec2 vUv;
      out vec4 outColor;
      void main() {
        vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
        vec3 color = texture(packedFrame, vec2(uv.x * 0.5, uv.y)).rgb;
        float alpha = texture(packedFrame, vec2(0.5 + uv.x * 0.5, uv.y)).r;
        outColor = vec4(color, alpha);
      }`));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    const texture = gl.createTexture();
    gl.useProgram(program);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.viewport(0, 0, canvas.width, canvas.height);
    const draw = () => {
      if (!canvas.isConnected || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(() => draw());
      else window.requestAnimationFrame(draw);
    };
    draw();
  };
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) initialize();
  else video.addEventListener('loadedmetadata', initialize, { once: true });
}

function evaluated(
  node: HorizonNode,
  path: string,
  snapshot: EvalSnapshot | undefined,
  fallback: unknown,
): unknown {
  return snapshot?.overrides.get(`${node.id}:${path}`) ?? node.properties[path] ?? fallback;
}

function stripUnsafeMarkup(markup: string, svg: boolean): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = markup;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  const remove: Element[] = [];
  while (walker.nextNode()) {
    const element = walker.currentNode as Element;
    const tag = element.tagName.toLowerCase();
    if (tag === 'script' || tag === 'iframe' || tag === 'object' || tag === 'embed') {
      remove.push(element);
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith('on') || ((name === 'href' || name === 'src' || name === 'xlink:href') && value.startsWith('javascript:'))) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  remove.forEach((element) => element.remove());

  if (svg) {
    const first = template.content.firstElementChild;
    if (first?.tagName.toLowerCase() !== 'svg') {
      const wrapper = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      wrapper.setAttribute('viewBox', '0 0 100 100');
      wrapper.append(...[...template.content.childNodes]);
      template.content.append(wrapper);
    }
  }
  return template.content;
}

/**
 * Keeps accessible HTML, SVG, and dynamic text as real DOM layered over the
 * render canvas. Project markup is data: executable elements and attributes
 * are removed before insertion.
 */
export class DomLayerAdapter {
  readonly element: HTMLDivElement;
  private elements = new Map<string, HTMLElement>();
  private contentKeys = new Map<string, string>();
  private objectUrls = new Map<string, string>();

  constructor(container: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'hz-dom-compositor';
    this.element.setAttribute('aria-live', 'off');
    container.appendChild(this.element);
  }

  syncProject(
    project: HorizonProject,
    snapshot?: EvalSnapshot,
    viewportCamera?: THREE.PerspectiveCamera,
  ): void {
    const composition = project.compositions[project.activeCompositionId];
    const activeIds = new Set<string>();
    if (!composition) return;

    const visit = (id: string, parentVisible: boolean, parentOpacity: number) => {
      const sourceNode = project.nodes[id];
      if (!sourceNode) return;
      const override = composition.nodeOverrides?.[id];
      const node = override ? {
        ...sourceNode,
        enabled: override.enabled ?? sourceNode.enabled,
        properties: { ...sourceNode.properties, ...(override.properties ?? {}) },
      } : sourceNode;
      const visibilityVisible = evaluated(node, 'visibility.visible', snapshot, true) !== false;
      const visible = parentVisible && node.enabled && visibilityVisible;
      const opacity = parentOpacity * Number(evaluated(node, 'visibility.opacity', snapshot, 1));
      if (DOM_LAYER_TYPES.has(node.type as string)) {
        activeIds.add(id);
        this.syncNode(project, node, visible, opacity, snapshot, viewportCamera);
      }
      node.children.forEach((childId) => visit(childId, visible, opacity));
    };
    resolveCompositionRootNodes(project, composition.id).forEach((id) => visit(id, true, 1));

    for (const [id, element] of this.elements) {
      if (activeIds.has(id)) continue;
      element.remove();
      const url = this.objectUrls.get(id);
      if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
      this.objectUrls.delete(id);
      this.elements.delete(id);
      this.contentKeys.delete(id);
    }
  }

  private syncNode(
    project: HorizonProject,
    node: HorizonNode,
    visible: boolean,
    inheritedOpacity: number,
    snapshot?: EvalSnapshot,
    viewportCamera?: THREE.PerspectiveCamera,
  ): void {
    let element = this.elements.get(node.id);
    if (!element) {
      element = document.createElement('div');
      element.className = 'hz-dom-layer';
      element.dataset.horizonNodeId = node.id;
      this.element.appendChild(element);
      this.elements.set(node.id, element);
    }

    const type = node.type as string;
    const content = String(
      evaluated(
        node,
        type === 'dynamicText' ? 'text.value' : `${type}.content`,
        snapshot,
        node.name,
      ),
    );
    const assetId = String(evaluated(node, 'asset.id', snapshot, ''));
    const alphaMode = String(evaluated(node, 'media.alphaMode', snapshot, 'auto'));
    const contentKey = type === 'image' || type === 'video' || type === 'audio'
      ? `${type}:${assetId}:${type === 'video' ? alphaMode : ''}`
      : `${type}:${content}`;
    if (this.contentKeys.get(node.id) !== contentKey) {
      element.replaceChildren();
      if (type === 'image' || type === 'video' || type === 'audio') {
        void this.mountMedia(project, node, element, type, assetId, contentKey);
      } else if (type === 'dynamicText') {
        element.textContent = content;
      } else {
        element.appendChild(stripUnsafeMarkup(content, type === 'svg'));
      }
      this.contentKeys.set(node.id, contentKey);
    }

    const anchorSpace = String(evaluated(node, 'layout.space', snapshot, 'screen'));
    const worldProjection = anchorSpace === 'world'
      ? this.projectWorldAnchor(project, node, snapshot, viewportCamera)
      : null;
    const position = worldProjection?.position
      ?? evaluated(node, 'layout.position', snapshot, [50, 50]);
    const size = evaluated(node, 'layout.size', snapshot, [40, 20]);
    const rotation = Number(evaluated(node, 'layout.rotation', snapshot, 0));
    const scale = Number(evaluated(node, 'layout.scale', snapshot, 1))
      * (worldProjection?.scale ?? 1);
    const opacity = Number(evaluated(node, 'layout.opacity', snapshot, 1)) * inheritedOpacity;
    const anchor = evaluated(node, 'layout.anchor', snapshot, [0.5, 0.5]);
    const zIndex = Number(evaluated(node, 'layout.zIndex', snapshot, 0));
    const interactive = Boolean(evaluated(node, 'interaction.enabled', snapshot, false));

    const p = Array.isArray(position) ? position : [50, 50];
    const s = Array.isArray(size) ? size : [40, 20];
    const a = Array.isArray(anchor) ? anchor : [0.5, 0.5];
    element.style.left = `${Number(p[0] ?? 50)}%`;
    element.style.top = `${Number(p[1] ?? 50)}%`;
    element.style.width = `${Number(s[0] ?? 40)}%`;
    element.style.height = `${Number(s[1] ?? 20)}%`;
    element.style.transform = `translate(${-Number(a[0] ?? 0.5) * 100}%, ${-Number(a[1] ?? 0.5) * 100}%) rotate(${rotation}deg) scale(${scale})`;
    element.style.opacity = String(Math.max(0, Math.min(1, opacity)));
    element.style.zIndex = String(zIndex);
    const projectedVisible = worldProjection?.visible ?? true;
    element.style.display = visible && projectedVisible ? '' : 'none';
    element.style.pointerEvents = interactive ? 'auto' : 'none';
    if (type === 'dynamicText') {
      element.style.color = String(evaluated(node, 'text.color', snapshot, '#f5f5f5'));
      element.style.fontSize = `${Number(evaluated(node, 'text.fontSize', snapshot, 32))}px`;
      element.style.fontWeight = String(evaluated(node, 'text.fontWeight', snapshot, 700));
      element.style.lineHeight = String(evaluated(node, 'text.lineHeight', snapshot, 1));
      element.style.letterSpacing = `${Number(evaluated(node, 'text.letterSpacing', snapshot, -0.04))}em`;
    }
    element.toggleAttribute('aria-hidden', !visible || !projectedVisible);
    const accessibleLabel = String(
      evaluated(
        node,
        'accessibility.label',
        snapshot,
        type === 'dynamicText' ? content : node.name,
      ),
    ).trim();
    const role = String(
      evaluated(
        node,
        'accessibility.role',
        snapshot,
        interactive ? 'button' : type === 'dynamicText' ? '' : 'group',
      ),
    ).trim();
    element.setAttribute('aria-label', accessibleLabel || node.name);
    if (role) element.setAttribute('role', role);
    else element.removeAttribute('role');
    if (interactive) element.tabIndex = Number(
      evaluated(node, 'accessibility.tabIndex', snapshot, 0),
    );
    else element.removeAttribute('tabindex');

    const media = element.querySelector('video, audio') as HTMLMediaElement | null;
    if (media) {
      media.loop = Boolean(evaluated(node, 'media.loop', snapshot, false));
      media.muted = Boolean(evaluated(node, 'media.muted', snapshot, type === 'video'));
      media.volume = Math.max(0, Math.min(1, Number(evaluated(node, 'media.volume', snapshot, 1))));
      const requestedTime = Number(evaluated(node, 'media.currentTime', snapshot, media.currentTime));
      const timeIsDriven = Boolean(snapshot?.overrides.has(`${node.id}:media.currentTime`));
      const autoplay = Boolean(evaluated(node, 'media.autoplay', snapshot, false));
      if ((timeIsDriven || !autoplay) && Number.isFinite(requestedTime) && Math.abs(media.currentTime - requestedTime) > 0.05) {
        media.currentTime = Math.max(0, requestedTime);
      }
      if (visible && autoplay) {
        void media.play().catch(() => undefined);
      } else if (!visible) {
        media.pause();
      }
    }
  }

  private projectWorldAnchor(
    project: HorizonProject,
    node: HorizonNode,
    snapshot?: EvalSnapshot,
    viewportCamera?: THREE.PerspectiveCamera,
  ): { position: [number, number]; scale: number; visible: boolean } | null {
    const composition = project.compositions[project.activeCompositionId];
    const cameraNode = composition ? project.nodes[composition.activeCamera] : undefined;
    if (!cameraNode) return null;

    const worldPosition = evaluated(node, 'transform.position', snapshot, [0, 0, 0]);
    if (!Array.isArray(worldPosition)) {
      return null;
    }

    let camera = viewportCamera;
    if (!camera) {
      const cameraPosition = evaluated(cameraNode, 'transform.position', snapshot, [0, 0, 10]);
      const lookAt = evaluated(cameraNode, 'camera.lookAt', snapshot, [0, 0, 0]);
      if (!Array.isArray(cameraPosition) || !Array.isArray(lookAt)) return null;
      const width = Math.max(this.element.clientWidth, 1);
      const height = Math.max(this.element.clientHeight, 1);
      const focalLength = Math.max(Number(evaluated(cameraNode, 'camera.focalLength', snapshot, 50)), 1);
      const sensorHeight = Math.max(Number(evaluated(cameraNode, 'camera.sensorHeight', snapshot, 24)), 1);
      const near = Math.max(Number(evaluated(cameraNode, 'camera.near', snapshot, 0.1)), 0.001);
      const far = Math.max(Number(evaluated(cameraNode, 'camera.far', snapshot, 1000)), near + 0.001);
      const fov = 2 * Math.atan(sensorHeight / (2 * focalLength)) * 180 / Math.PI;
      camera = new THREE.PerspectiveCamera(fov, width / height, near, far);
      camera.position.set(Number(cameraPosition[0]), Number(cameraPosition[1]), Number(cameraPosition[2]));
      camera.lookAt(Number(lookAt[0]), Number(lookAt[1]), Number(lookAt[2]));
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
    }

    const point = new THREE.Vector3(
      Number(worldPosition[0]),
      Number(worldPosition[1]),
      Number(worldPosition[2]),
    );
    const cameraSpace = point.clone().applyMatrix4(camera.matrixWorldInverse);
    const effectiveNear = Math.max(camera.near, 0.001);
    const visible = cameraSpace.z < -effectiveNear;
    point.project(camera);
    const distance = Math.max(-cameraSpace.z, effectiveNear);
    const authoredScale = Math.max(
      0.01,
      Number(evaluated(node, 'layout.worldScale', snapshot, 1)),
    );
    return {
      position: [(point.x + 1) * 50, (1 - point.y) * 50],
      scale: authoredScale * Math.max(0.18, Math.min(4, 10 / distance)),
      visible,
    };
  }

  private async mountMedia(
    project: HorizonProject,
    node: HorizonNode,
    host: HTMLElement,
    type: string,
    assetId: string,
    contentKey: string,
  ): Promise<void> {
    const asset = project.assets[assetId] as import('../../core/types').AssetRecord | undefined;
    if (!asset) {
      host.textContent = `Missing ${type} asset`;
      return;
    }
    const url = await resolveAssetUrl(asset);
    if (!url || this.contentKeys.get(node.id) !== contentKey) {
      if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
      return;
    }
    const previousUrl = this.objectUrls.get(node.id);
    if (previousUrl?.startsWith('blob:')) URL.revokeObjectURL(previousUrl);
    if (url.startsWith('blob:')) this.objectUrls.set(node.id, url);

    const media =
      type === 'image'
        ? document.createElement('img')
        : document.createElement(type === 'video' ? 'video' : 'audio');
    media.setAttribute('src', url);
    media.setAttribute('aria-label', node.name);
    if (media instanceof HTMLImageElement || media instanceof HTMLVideoElement) {
      media.style.width = '100%';
      media.style.height = '100%';
      media.style.objectFit = String(node.properties['image.fit'] ?? 'contain');
    }
    if (media instanceof HTMLMediaElement) {
      media.preload = 'auto';
      media.controls = Boolean(node.properties['media.controls']);
    }
    if (media instanceof HTMLVideoElement) media.playsInline = true;
    if (media instanceof HTMLVideoElement) {
      const alphaMode = String(node.properties['media.alphaMode'] ?? asset.metadata?.alphaMode ?? 'auto');
      media.dataset.alphaMode = alphaMode;
      media.style.background = 'transparent';
      if (alphaMode === 'packed-sbs') {
        const canvas = document.createElement('canvas');
        canvas.className = 'hz-packed-alpha-video';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.objectFit = 'contain';
        media.style.display = 'none';
        host.replaceChildren(media, canvas);
        mountPackedAlphaDecoder(media, canvas);
        return;
      }
    }
    host.replaceChildren(media);
  }

  getElement(nodeId: string): HTMLElement | null {
    return this.elements.get(nodeId) ?? null;
  }

  dispose(): void {
    for (const url of this.objectUrls.values()) {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    }
    this.objectUrls.clear();
    this.elements.clear();
    this.contentKeys.clear();
    this.element.remove();
  }
}
