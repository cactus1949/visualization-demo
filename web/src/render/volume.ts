import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  Break,
  Fn,
  If,
  exp,
  float,
  max,
  select,
  texture,
  texture3D,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { RaymarchingBox } from "three/addons/tsl/utils/Raymarching.js";
import type { Manifest, VariableMeta } from "../data/manifest";
import { colorTexture } from "./colormaps";
import { worldSize } from "./coords";

export interface VolumeHandle {
  object: THREE.Mesh;
  material: NodeMaterial;
  steps: { value: number };
  opacity: { value: number };
  threshold: { value: number };
  windowLow: { value: number };
  windowHigh: { value: number };
}

/**
 * GPU raymarched volume.
 *
 * A unit cube (-0.5..0.5) is scaled to the domain size. RaymarchingBox (three/addons)
 * intersects the camera ray with the cube in model space and marches through it.
 * Each sample reads the uint8 texel (0..1 in the shader), converts it back to the
 * physical value (texel * 255 * scale + offset), maps it through the user window to
 * the colormap, and composites front to back until the ray is nearly opaque.
 */
export function makeVolume(
  manifest: Manifest,
  meta: VariableMeta,
  data: Uint8Array,
  exaggeration: number,
): VolumeHandle {
  const size = worldSize(manifest, exaggeration);
  const scalarTexture = new THREE.Data3DTexture(
    data,
    manifest.grid.nx,
    manifest.grid.ny,
    manifest.grid.nz,
  );
  scalarTexture.format = THREE.RedFormat;
  scalarTexture.type = THREE.UnsignedByteType;
  scalarTexture.minFilter = THREE.LinearFilter;
  scalarTexture.magFilter = THREE.LinearFilter;
  scalarTexture.unpackAlignment = 1;
  scalarTexture.needsUpdate = true;

  const transferTexture = colorTexture(meta.colormap);
  const steps = uniform(160);
  const opacity = uniform(0.8);
  const threshold = uniform(meta.range[0]);
  const windowLow = uniform(meta.range[0]);
  const windowHigh = uniform(meta.range[1]);
  const physicalScale = float(meta.scale * 255);
  const physicalOffset = float(meta.offset);

  const material = new NodeMaterial();
  material.side = THREE.BackSide;
  material.transparent = true;
  material.depthWrite = false;
  // The bottom face coincides with the ground/surface layer; the volume always sits above it,
  // so skip the depth test instead of losing every ray that exits through the floor.
  material.depthTest = false;

  material.colorNode = Fn(() => {
    const accumulated = vec4(0).toVar();
    RaymarchingBox(steps, ({ positionRay, stepSize }: any) => {
      // model space → texture uvw: x = east, data row index grows to the north (-z), y = height
      const uvw = vec3(
        positionRay.x.add(0.5),
        positionRay.z.negate().add(0.5),
        positionRay.y.add(0.5),
      );
      const texel = texture3D(scalarTexture, uvw, 0).r;
      const physical = texel.mul(physicalScale).add(physicalOffset);
      const t = physical
        .sub(windowLow)
        .div(max(windowHigh.sub(windowLow), 1e-6))
        .clamp(0, 1);
      const color = texture(transferTexture, vec2(t, 0.5)).rgb;
      // Beer-Lambert style extinction; higher values are denser so structure stands out.
      const density = select(physical.greaterThanEqual(threshold), t.mul(t).add(0.02), float(0));
      const alpha = float(1).sub(exp(density.mul(opacity).mul(stepSize).mul(-30.0)));
      const remaining = float(1).sub(accumulated.a);
      accumulated.rgb.addAssign(color.mul(alpha).mul(remaining));
      accumulated.a.addAssign(alpha.mul(remaining));
      If(accumulated.a.greaterThan(0.97), () => {
        Break();
      });
    });
    return vec4(accumulated.rgb.div(max(accumulated.a, 1e-4)), accumulated.a);
  })();

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  mesh.scale.set(size.x, size.y, size.z);
  mesh.position.y = size.y / 2;
  mesh.renderOrder = 1;
  mesh.userData.texture = scalarTexture;
  mesh.userData.transferTexture = transferTexture;
  mesh.userData.isVolume = true;
  return { object: mesh, material, steps, opacity, threshold, windowLow, windowHigh };
}

export function disposeVolume(handle: VolumeHandle): void {
  handle.object.parent?.remove(handle.object);
  handle.object.geometry.dispose();
  handle.material.dispose();
  (handle.object.userData.texture as THREE.Texture).dispose();
  (handle.object.userData.transferTexture as THREE.Texture).dispose();
}
