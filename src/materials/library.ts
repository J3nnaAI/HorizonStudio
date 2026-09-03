/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MaterialDef } from '../core/types';
import { createGraphiteMaterial } from '../shaders/graphite';
import { createFloorMaterial } from '../shaders/floor';
import { createPhysicalMaterial } from '../shaders/physical';
import { createGlassMaterial } from '../shaders/glass';
import { createUnlitMaterial } from '../shaders/unlit';
import { createSubsurfaceMaterial } from '../shaders/subsurface';

export type MaterialCategory =
  | 'metals'
  | 'dielectrics'
  | 'glass'
  | 'plastics'
  | 'fabrics'
  | 'organic'
  | 'emissive'
  | 'studio'
  | 'unlit';

export interface LibraryMaterialSpec {
  id: string;
  category: MaterialCategory;
  label: string;
  create: () => MaterialDef;
}

function withId(material: MaterialDef, id: string): MaterialDef {
  return { ...material, id };
}

/** Built-in catalog. Stable IDs keep library materials idempotent across reloads. */
export const MATERIAL_LIBRARY: LibraryMaterialSpec[] = [
  // Studio / hero
  {
    id: 'mat_lib_graphite',
    category: 'studio',
    label: 'Graphite',
    create: () => withId(createGraphiteMaterial('Graphite'), 'mat_lib_graphite'),
  },
  {
    id: 'mat_lib_obsidian_floor',
    category: 'studio',
    label: 'Obsidian Floor',
    create: () => withId(createFloorMaterial('Obsidian Floor'), 'mat_lib_obsidian_floor'),
  },
  {
    id: 'mat_lib_brushed_copper',
    category: 'metals',
    label: 'Brushed Copper',
    create: () =>
      withId(
        createPhysicalMaterial('Brushed Copper', {
          baseColor: '#b8652d',
          metalness: 0.92,
          roughness: 0.24,
          anisotropy: 0.72,
          anisotropyRotation: Math.PI / 2,
          clearcoat: 0.2,
          envMapIntensity: 1.35,
        }),
        'mat_lib_brushed_copper',
      ),
  },

  // Metals
  {
    id: 'mat_lib_chrome',
    category: 'metals',
    label: 'Chrome',
    create: () =>
      withId(
        createPhysicalMaterial('Chrome', {
          baseColor: '#c8ccd2',
          metalness: 1,
          roughness: 0.05,
          envMapIntensity: 1.6,
        }),
        'mat_lib_chrome',
      ),
  },
  {
    id: 'mat_lib_brushed_steel',
    category: 'metals',
    label: 'Brushed Steel',
    create: () =>
      withId(
        createPhysicalMaterial('Brushed Steel', {
          baseColor: '#8b9198',
          metalness: 1,
          roughness: 0.32,
          anisotropy: 0.55,
          anisotropyRotation: Math.PI / 2,
        }),
        'mat_lib_brushed_steel',
      ),
  },
  {
    id: 'mat_lib_gold',
    category: 'metals',
    label: 'Gold',
    create: () =>
      withId(
        createPhysicalMaterial('Gold', {
          baseColor: '#d4a017',
          metalness: 1,
          roughness: 0.18,
          envMapIntensity: 1.4,
        }),
        'mat_lib_gold',
      ),
  },
  {
    id: 'mat_lib_silver',
    category: 'metals',
    label: 'Silver',
    create: () =>
      withId(
        createPhysicalMaterial('Silver', {
          baseColor: '#d9dde3',
          metalness: 1,
          roughness: 0.12,
        }),
        'mat_lib_silver',
      ),
  },
  {
    id: 'mat_lib_aluminum',
    category: 'metals',
    label: 'Aluminum',
    create: () =>
      withId(
        createPhysicalMaterial('Aluminum', {
          baseColor: '#b0b6bd',
          metalness: 1,
          roughness: 0.28,
        }),
        'mat_lib_aluminum',
      ),
  },
  {
    id: 'mat_lib_iron',
    category: 'metals',
    label: 'Iron',
    create: () =>
      withId(
        createPhysicalMaterial('Iron', {
          baseColor: '#6a6e74',
          metalness: 1,
          roughness: 0.45,
        }),
        'mat_lib_iron',
      ),
  },
  {
    id: 'mat_lib_bronze',
    category: 'metals',
    label: 'Bronze',
    create: () =>
      withId(
        createPhysicalMaterial('Bronze', {
          baseColor: '#8c5a2b',
          metalness: 1,
          roughness: 0.35,
        }),
        'mat_lib_bronze',
      ),
  },
  {
    id: 'mat_lib_titanium',
    category: 'metals',
    label: 'Titanium',
    create: () =>
      withId(
        createPhysicalMaterial('Titanium', {
          baseColor: '#9aa0a8',
          metalness: 1,
          roughness: 0.22,
          iridescence: 0.35,
          iridescenceIOR: 1.5,
        }),
        'mat_lib_titanium',
      ),
  },
  {
    id: 'mat_lib_gunmetal',
    category: 'metals',
    label: 'Gunmetal',
    create: () =>
      withId(
        createPhysicalMaterial('Gunmetal', {
          baseColor: '#2c3036',
          metalness: 0.95,
          roughness: 0.4,
          clearcoat: 0.15,
        }),
        'mat_lib_gunmetal',
      ),
  },

  // Dielectrics
  {
    id: 'mat_lib_concrete',
    category: 'dielectrics',
    label: 'Concrete',
    create: () =>
      withId(
        createPhysicalMaterial('Concrete', {
          baseColor: '#7a7a76',
          metalness: 0,
          roughness: 0.92,
          microTexture: 0.55,
          bumpScale: 0.02,
        }),
        'mat_lib_concrete',
      ),
  },
  {
    id: 'mat_lib_asphalt',
    category: 'dielectrics',
    label: 'Asphalt',
    create: () =>
      withId(
        createPhysicalMaterial('Asphalt', {
          baseColor: '#1c1c1c',
          metalness: 0,
          roughness: 0.88,
          microTexture: 0.4,
        }),
        'mat_lib_asphalt',
      ),
  },
  {
    id: 'mat_lib_ceramic_white',
    category: 'dielectrics',
    label: 'White Ceramic',
    create: () =>
      withId(
        createPhysicalMaterial('White Ceramic', {
          baseColor: '#f2f0ea',
          metalness: 0,
          roughness: 0.28,
          clearcoat: 0.65,
          clearcoatRoughness: 0.12,
        }),
        'mat_lib_ceramic_white',
      ),
  },
  {
    id: 'mat_lib_matte_black',
    category: 'dielectrics',
    label: 'Matte Black',
    create: () =>
      withId(
        createPhysicalMaterial('Matte Black', {
          baseColor: '#0b0b0b',
          metalness: 0,
          roughness: 0.85,
        }),
        'mat_lib_matte_black',
      ),
  },
  {
    id: 'mat_lib_porcelain',
    category: 'dielectrics',
    label: 'Porcelain',
    create: () =>
      withId(
        createPhysicalMaterial('Porcelain', {
          baseColor: '#f7f4ef',
          metalness: 0,
          roughness: 0.22,
          clearcoat: 0.8,
          clearcoatRoughness: 0.08,
          sheen: 0.12,
        }),
        'mat_lib_porcelain',
      ),
  },
  {
    id: 'mat_lib_rubber',
    category: 'dielectrics',
    label: 'Rubber',
    create: () =>
      withId(
        createPhysicalMaterial('Rubber', {
          baseColor: '#1a1a1a',
          metalness: 0,
          roughness: 0.95,
          sheen: 0.05,
        }),
        'mat_lib_rubber',
      ),
  },
  {
    id: 'mat_lib_wood_oak',
    category: 'dielectrics',
    label: 'Oak Wood',
    create: () =>
      withId(
        createPhysicalMaterial('Oak Wood', {
          baseColor: '#8b5a2b',
          metalness: 0,
          roughness: 0.62,
          anisotropy: 0.25,
          clearcoat: 0.2,
          clearcoatRoughness: 0.4,
        }),
        'mat_lib_wood_oak',
      ),
  },
  {
    id: 'mat_lib_marble',
    category: 'dielectrics',
    label: 'Marble',
    create: () =>
      withId(
        createPhysicalMaterial('Marble', {
          baseColor: '#e8e4dc',
          metalness: 0,
          roughness: 0.25,
          clearcoat: 0.45,
          clearcoatRoughness: 0.15,
          microTexture: 0.2,
        }),
        'mat_lib_marble',
      ),
  },

  // Glass
  {
    id: 'mat_lib_clear_glass',
    category: 'glass',
    label: 'Clear Glass',
    create: () => withId(createGlassMaterial('Clear Glass'), 'mat_lib_clear_glass'),
  },
  {
    id: 'mat_lib_frosted_glass',
    category: 'glass',
    label: 'Frosted Glass',
    create: () =>
      withId(
        createGlassMaterial('Frosted Glass', {
          roughness: 0.35,
          transmission: 0.92,
          thickness: 0.4,
          causticsStrength: 0.32,
          causticsFocus: 0.28,
          causticsChromatic: 0.06,
        }),
        'mat_lib_frosted_glass',
      ),
  },
  {
    id: 'mat_lib_amber_glass',
    category: 'glass',
    label: 'Amber Glass',
    create: () =>
      withId(
        createGlassMaterial('Amber Glass', {
          baseColor: '#ffb347',
          attenuationColor: '#ff8c1a',
          attenuationDistance: 0.35,
          transmission: 0.95,
          causticsStrength: 0.72,
          causticsChromatic: 0.22,
        }),
        'mat_lib_amber_glass',
      ),
  },
  {
    id: 'mat_lib_emerald_glass',
    category: 'glass',
    label: 'Emerald Glass',
    create: () =>
      withId(
        createGlassMaterial('Emerald Glass', {
          baseColor: '#3dff9a',
          attenuationColor: '#00a85a',
          attenuationDistance: 0.4,
          causticsStrength: 0.78,
          causticsChromatic: 0.2,
        }),
        'mat_lib_emerald_glass',
      ),
  },
  {
    id: 'mat_lib_diamond',
    category: 'glass',
    label: 'Diamond',
    create: () =>
      withId(
        createPhysicalMaterial('Diamond', {
          baseColor: '#ffffff',
          metalness: 0,
          roughness: 0.02,
          transmission: 1,
          thickness: 0.6,
          ior: 2.42,
          clearcoat: 1,
          clearcoatRoughness: 0.02,
          envMapIntensity: 1.8,
          dispersion: 0.72,
          causticsEnabled: true,
          causticsStrength: 1.45,
          causticsScale: 1.25,
          causticsFocus: 0.9,
          causticsChromatic: 0.82,
        }),
        'mat_lib_diamond',
      ),
  },

  // Plastics
  {
    id: 'mat_lib_plastic_red',
    category: 'plastics',
    label: 'Red Plastic',
    create: () =>
      withId(
        createPhysicalMaterial('Red Plastic', {
          baseColor: '#c62828',
          metalness: 0,
          roughness: 0.35,
          clearcoat: 0.4,
          clearcoatRoughness: 0.2,
        }),
        'mat_lib_plastic_red',
      ),
  },
  {
    id: 'mat_lib_plastic_blue',
    category: 'plastics',
    label: 'Blue Plastic',
    create: () =>
      withId(
        createPhysicalMaterial('Blue Plastic', {
          baseColor: '#1565c0',
          metalness: 0,
          roughness: 0.35,
          clearcoat: 0.4,
        }),
        'mat_lib_plastic_blue',
      ),
  },
  {
    id: 'mat_lib_abs_black',
    category: 'plastics',
    label: 'ABS Black',
    create: () =>
      withId(
        createPhysicalMaterial('ABS Black', {
          baseColor: '#121212',
          metalness: 0,
          roughness: 0.48,
        }),
        'mat_lib_abs_black',
      ),
  },
  {
    id: 'mat_lib_acrylic',
    category: 'plastics',
    label: 'Acrylic',
    create: () =>
      withId(
        createPhysicalMaterial('Acrylic', {
          baseColor: '#f5f7fa',
          metalness: 0,
          roughness: 0.12,
          clearcoat: 0.7,
          clearcoatRoughness: 0.08,
          transmission: 0.15,
        }),
        'mat_lib_acrylic',
      ),
  },

  // Fabrics
  {
    id: 'mat_lib_velvet',
    category: 'fabrics',
    label: 'Velvet',
    create: () =>
      withId(
        createPhysicalMaterial('Velvet', {
          baseColor: '#4a0e2a',
          metalness: 0,
          roughness: 0.78,
          sheen: 1,
          sheenColor: '#c45a8a',
          sheenRoughness: 0.35,
        }),
        'mat_lib_velvet',
      ),
  },
  {
    id: 'mat_lib_silk',
    category: 'fabrics',
    label: 'Silk',
    create: () =>
      withId(
        createPhysicalMaterial('Silk', {
          baseColor: '#e8dcc8',
          metalness: 0,
          roughness: 0.4,
          sheen: 0.85,
          sheenColor: '#fff6e8',
          sheenRoughness: 0.25,
          anisotropy: 0.4,
        }),
        'mat_lib_silk',
      ),
  },
  {
    id: 'mat_lib_denim',
    category: 'fabrics',
    label: 'Denim',
    create: () =>
      withId(
        createPhysicalMaterial('Denim', {
          baseColor: '#2b3f66',
          metalness: 0,
          roughness: 0.82,
          sheen: 0.2,
          microTexture: 0.35,
        }),
        'mat_lib_denim',
      ),
  },

  // Organic / SSS
  {
    id: 'mat_lib_skin',
    category: 'organic',
    label: 'Skin',
    create: () =>
      withId(
        createSubsurfaceMaterial('Skin', {
          baseColor: '#e5c8b8',
          subsurfaceColor: '#ff6a4a',
          subsurfaceStrength: 0.7,
          roughness: 0.5,
        }),
        'mat_lib_skin',
      ),
  },
  {
    id: 'mat_lib_wax',
    category: 'organic',
    label: 'Wax',
    create: () =>
      withId(
        createSubsurfaceMaterial('Wax', {
          baseColor: '#f3e6c8',
          subsurfaceColor: '#ffb45a',
          subsurfaceStrength: 0.9,
          roughness: 0.35,
        }),
        'mat_lib_wax',
      ),
  },
  {
    id: 'mat_lib_jade',
    category: 'organic',
    label: 'Jade',
    create: () =>
      withId(
        createSubsurfaceMaterial('Jade', {
          baseColor: '#3f8f6a',
          subsurfaceColor: '#8dffc2',
          subsurfaceStrength: 1.1,
          roughness: 0.28,
          clearcoat: 0.35,
        }),
        'mat_lib_jade',
      ),
  },
  {
    id: 'mat_lib_leaf',
    category: 'organic',
    label: 'Leaf',
    create: () =>
      withId(
        createSubsurfaceMaterial('Leaf', {
          baseColor: '#3d7a2c',
          subsurfaceColor: '#a8ff4a',
          subsurfaceStrength: 0.8,
          roughness: 0.55,
        }),
        'mat_lib_leaf',
      ),
  },

  // Emissive
  {
    id: 'mat_lib_neon_orange',
    category: 'emissive',
    label: 'Neon Orange',
    create: () =>
      withId(
        createPhysicalMaterial('Neon Orange', {
          baseColor: '#1a0a00',
          metalness: 0,
          roughness: 0.4,
          emissiveColor: '#ff5612',
          emissiveIntensity: 4.5,
          bloom: true,
        }),
        'mat_lib_neon_orange',
      ),
  },
  {
    id: 'mat_lib_neon_cyan',
    category: 'emissive',
    label: 'Neon Cyan',
    create: () =>
      withId(
        createPhysicalMaterial('Neon Cyan', {
          baseColor: '#001018',
          metalness: 0,
          roughness: 0.35,
          emissiveColor: '#28e0ff',
          emissiveIntensity: 4,
          bloom: true,
        }),
        'mat_lib_neon_cyan',
      ),
  },
  {
    id: 'mat_lib_led_white',
    category: 'emissive',
    label: 'LED White',
    create: () =>
      withId(
        createPhysicalMaterial('LED White', {
          baseColor: '#101010',
          metalness: 0,
          roughness: 0.3,
          emissiveColor: '#ffffff',
          emissiveIntensity: 6,
          bloom: true,
        }),
        'mat_lib_led_white',
      ),
  },
  {
    id: 'mat_lib_lava',
    category: 'emissive',
    label: 'Lava',
    create: () =>
      withId(
        createPhysicalMaterial('Lava', {
          baseColor: '#1a0500',
          metalness: 0.1,
          roughness: 0.55,
          emissiveColor: '#ff2a00',
          emissiveIntensity: 3.2,
          bloom: true,
        }),
        'mat_lib_lava',
      ),
  },

  // Unlit
  {
    id: 'mat_lib_unlit_white',
    category: 'unlit',
    label: 'Unlit White',
    create: () => withId(createUnlitMaterial('Unlit White', { color: '#ffffff' }), 'mat_lib_unlit_white'),
  },
  {
    id: 'mat_lib_unlit_mask',
    category: 'unlit',
    label: 'Unlit Mask Black',
    create: () =>
      withId(
        createUnlitMaterial('Unlit Mask Black', {
          color: '#000000',
          bloom: false,
          toneMapped: false,
        }),
        'mat_lib_unlit_mask',
      ),
  },
];

export const MATERIAL_CATEGORIES: Array<{ id: MaterialCategory; label: string }> = [
  { id: 'studio', label: 'Studio' },
  { id: 'metals', label: 'Metals' },
  { id: 'dielectrics', label: 'Dielectrics' },
  { id: 'glass', label: 'Glass' },
  { id: 'plastics', label: 'Plastics' },
  { id: 'fabrics', label: 'Fabrics' },
  { id: 'organic', label: 'Organic' },
  { id: 'emissive', label: 'Emissive' },
  { id: 'unlit', label: 'Unlit' },
];

/** Insert any missing library materials into the project (does not overwrite user edits). */
export function ensureLibraryMaterials(materials: Record<string, MaterialDef>): number {
  let added = 0;
  for (const spec of MATERIAL_LIBRARY) {
    const current = materials[spec.id];
    const seeded = spec.create();
    if (!current) {
      materials[spec.id] = seeded;
      added += 1;
      continue;
    }
    // Library IDs are stable across releases. Backfill newly introduced
    // capabilities without overwriting a user's existing material tuning.
    current.parameters = { ...seeded.parameters, ...current.parameters };
  }
  return added;
}

export function libraryCategoryForMaterial(material: MaterialDef): MaterialCategory | 'custom' {
  const spec = MATERIAL_LIBRARY.find((entry) => entry.id === material.id);
  return spec?.category ?? 'custom';
}
