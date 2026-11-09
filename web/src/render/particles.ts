import * as THREE from "three";
import { SpriteNodeMaterial } from "three/webgpu";
import {
  Fn,
  If,
  float,
  hash,
  instanceIndex,
  instancedArray,
  length,
  texture,
  texture3D,
  uniform,
  vec2,
  vec3,
} from "three/tsl";
import type { Manifest } from "../data/manifest";
import { worldSize } from "./coords";
import { colorTexture } from "./colormaps";

export type ParticlePath = "gpu-compute-webgpu" | "gpu-compute-webgl2" | "cpu";

export const PARTICLE_PATH_LABEL: Record<ParticlePath, string> = {
  "gpu-compute-webgpu": "粒子: GPU 计算 (WebGPU compute shader)",
  "gpu-compute-webgl2": "粒子: GPU 计算 (WebGL2 变换反馈模拟)",
  cpu: "粒子: CPU (降级)",
};

export interface ParticleHandle {
  object: THREE.Object3D;
  path: ParticlePath;
  label: string;
  count: number;
  /** multiplier on real wind speed (1 = 120x real time) */
  speed: { value: number };
  step: (deltaSeconds: number) => void;
  /** first particle position, read back from the GPU when needed */
  sample: () => Promise<number[]>;
  dispose: () => void;
}

/** u, v, w packed into RGB of one RGBA8 3D texture (alpha unused). */
export function packWindTexture(
  manifest: Manifest,
  u: Uint8Array,
  v: Uint8Array,
  w: Uint8Array,
): THREE.Data3DTexture {
  const packed = new Uint8Array(u.length * 4);
  for (let index = 0; index < u.length; index += 1) {
    packed[index * 4] = u[index];
    packed[index * 4 + 1] = v[index];
    packed[index * 4 + 2] = w[index];
    packed[index * 4 + 3] = 255;
  }
  const texture3d = new THREE.Data3DTexture(
    packed,
    manifest.grid.nx,
    manifest.grid.ny,
    manifest.grid.nz,
  );
  texture3d.format = THREE.RGBAFormat;
  texture3d.type = THREE.UnsignedByteType;
  texture3d.minFilter = THREE.LinearFilter;
  texture3d.magFilter = THREE.LinearFilter;
  texture3d.unpackAlignment = 1;
  texture3d.needsUpdate = true;
  return texture3d;
}

// Simulated seconds per real second. 10 m/s wind crosses the 18 km box in ~15 s.
const TIME_SCALE = 120;
const SPEED_COLOR_MAX = 15;

function randomPositions(count: number, size: { x: number; y: number; z: number }) {
  const positions = new Float32Array(count * 3);
  const life = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = (Math.random() - 0.5) * size.x;
    positions[i * 3 + 1] = Math.random() * size.y;
    positions[i * 3 + 2] = (Math.random() - 0.5) * size.z;
    life[i] = Math.random() * 8;
  }
  return { positions, life };
}

/**
 * GPGPU particle advection.
 *
 * Positions/lifetimes/speeds live in GPU storage buffers (instancedArray). A TSL compute
 * kernel samples the packed u/v/w texture, converts the quantized texel back to m/s,
 * moves the particle, and respawns it at a hashed random location when it leaves the box
 * or its lifetime ends. The same kernel runs as a WebGPU compute shader or, on the
 * WebGL2 backend, through three.js's transform-feedback emulation. Rendering reads the
 * same buffer directly (no CPU copy). The CPU path is only used if building the GPU
 * path throws.
 */
export function makeParticles(
  renderer: any,
  manifest: Manifest,
  windTexture: THREE.Data3DTexture,
  exaggeration: number,
  count = 50_000,
  windData?: { u: Uint8Array; v: Uint8Array; w: Uint8Array },
): ParticleHandle {
  const n = Math.min(200_000, Math.max(1_000, Math.round(count)));
  const size = worldSize(manifest, exaggeration);
  const { u: uMeta, v: vMeta, w: wMeta } = manifest.variables;
  const { positions, life } = randomPositions(n, size);
  const speed = uniform(1.0);
  const colormap = colorTexture("turbo");
  const isWebGPU = renderer.backend?.isWebGPUBackend === true;

  try {
    const positionBuffer = instancedArray(positions, "vec3");
    const lifeBuffer = instancedArray(life, "float");
    const speedBuffer = instancedArray(n, "float");
    const dt = uniform(0.016);
    const seed = uniform(0);
    const span = vec3(uMeta.scale * 255, vMeta.scale * 255, wMeta.scale * 255);
    const base = vec3(uMeta.offset, vMeta.offset, wMeta.offset);

    const update = Fn(() => {
      const position = positionBuffer.element(instanceIndex);
      const age = lifeBuffer.element(instanceIndex);
      const uvw = vec3(
        position.x.div(size.x).add(0.5),
        position.z.div(size.z).negate().add(0.5),
        position.y.div(size.y),
      );
      const wind = texture3D(windTexture, uvw, 0).xyz.mul(span).add(base); // m/s
      // world units: x,z are km, y is km * exaggeration; north is -z
      const velocity = vec3(
        wind.x.div(1000),
        wind.z.mul(size.y).div(1000),
        wind.y.negate().div(1000),
      ).mul(TIME_SCALE);
      position.addAssign(velocity.mul(dt).mul(speed));
      age.subAssign(dt);
      speedBuffer.element(instanceIndex).assign(length(wind));

      const outside = position.x
        .abs()
        .greaterThan(size.x / 2)
        .or(position.z.abs().greaterThan(size.z / 2))
        .or(position.y.lessThan(0))
        .or(position.y.greaterThan(size.y));
      If(age.lessThan(0).or(outside), () => {
        const key = instanceIndex.toFloat().add(seed);
        position.assign(
          vec3(
            hash(key).sub(0.5).mul(size.x),
            hash(key.add(1013.0)).mul(size.y),
            hash(key.add(2027.0)).sub(0.5).mul(size.z),
          ),
        );
        age.assign(hash(key.add(3041.0)).mul(6).add(2));
      });
    })().compute(n);

    const material = new SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    material.positionNode = positionBuffer.toAttribute();
    const s = speedBuffer.toAttribute().div(SPEED_COLOR_MAX).clamp(0, 1);
    material.colorNode = texture(colormap, vec2(s, 0.5)).rgb;
    material.opacityNode = float(0.6);
    material.scaleNode = float(0.022);
    const sprite = new THREE.Sprite(material);
    (sprite as any).count = n;
    sprite.frustumCulled = false;
    sprite.renderOrder = 3;

    const path: ParticlePath = isWebGPU ? "gpu-compute-webgpu" : "gpu-compute-webgl2";
    let frame = 0;
    return {
      object: sprite,
      path,
      label: PARTICLE_PATH_LABEL[path],
      count: n,
      speed,
      step(deltaSeconds: number) {
        dt.value = deltaSeconds;
        seed.value = (frame++ * 7919) % 1_000_003;
        renderer.compute(update);
      },
      async sample() {
        try {
          const buffer: ArrayBuffer = await renderer.getArrayBufferAsync(positionBuffer.value);
          return Array.from(new Float32Array(buffer, 0, 3));
        } catch {
          return [];
        }
      },
      dispose() {
        material.dispose();
        colormap.dispose();
      },
    };
  } catch (error) {
    console.warn("GPU particle path unavailable, using CPU fallback", error);
  }

  // ---- CPU fallback: same physics on the main thread (nearest-neighbour sampling) ----
  const geometry = new THREE.BufferGeometry();
  const colors = new Float32Array(n * 3);
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size: 2,
    vertexColors: true,
    sizeAttenuation: false,
    transparent: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 3;
  const { nx, ny, nz } = manifest.grid;
  const color = new THREE.Color();
  const decode = (bytes: Uint8Array | undefined, index: number, meta: typeof uMeta) =>
    bytes ? bytes[index] * meta.scale + meta.offset : 0;
  return {
    object: points,
    path: "cpu",
    label: PARTICLE_PATH_LABEL.cpu,
    count: n,
    speed,
    step(deltaSeconds: number) {
      for (let i = 0; i < n; i += 1) {
        const o = i * 3;
        const ix = Math.round((positions[o] / size.x + 0.5) * (nx - 1));
        const iy = Math.round((0.5 - positions[o + 2] / size.z) * (ny - 1));
        const iz = Math.min(nz - 1, Math.max(0, Math.floor((positions[o + 1] / size.y) * nz)));
        const index = iz * nx * ny + iy * nx + ix;
        const wu = decode(windData?.u, index, uMeta);
        const wv = decode(windData?.v, index, vMeta);
        const ww = decode(windData?.w, index, wMeta);
        const k = (TIME_SCALE * deltaSeconds * speed.value) / 1000;
        positions[o] += wu * k;
        positions[o + 1] += ww * size.y * k;
        positions[o + 2] -= wv * k;
        life[i] -= deltaSeconds;
        if (
          life[i] < 0 ||
          Math.abs(positions[o]) > size.x / 2 ||
          Math.abs(positions[o + 2]) > size.z / 2 ||
          positions[o + 1] < 0 ||
          positions[o + 1] > size.y
        ) {
          positions[o] = (Math.random() - 0.5) * size.x;
          positions[o + 1] = Math.random() * size.y;
          positions[o + 2] = (Math.random() - 0.5) * size.z;
          life[i] = 2 + Math.random() * 6;
        }
        const t = Math.min(1, Math.hypot(wu, wv, ww) / SPEED_COLOR_MAX);
        color.setHSL(0.66 - 0.66 * t, 1, 0.55);
        colors[o] = color.r;
        colors[o + 1] = color.g;
        colors[o + 2] = color.b;
      }
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.color.needsUpdate = true;
    },
    async sample() {
      return [positions[0], positions[1], positions[2]];
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      colormap.dispose();
    },
  };
}
