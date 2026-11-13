import * as THREE from "three";
import type { VariableMeta } from "../data/manifest";
import { colormapBytes } from "./colormaps";
import type { Domain } from "./fields";

export type Theme = "dark" | "light";

export const THEMES: Record<
  Theme,
  { background: number; fog: number; ground: number; grid: number; frame: number }
> = {
  dark: { background: 0x0a1220, fog: 0x0a1220, ground: 0x1b2633, grid: 0x2c4356, frame: 0x5d8fa8 },
  light: { background: 0xdfe7ee, fog: 0xdfe7ee, ground: 0xc9d2da, grid: 0xa9b8c4, frame: 0x6f8797 },
};

/** Scene, lights, ground, frame and north arrow. Layers are added to `root` by the viewer. */
export class AtmosScene {
  readonly scene = new THREE.Scene();
  readonly root = new THREE.Group();
  readonly ground: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private readonly grid: THREE.LineSegments;
  private readonly frame: THREE.LineSegments;
  private groundTexture: THREE.DataTexture | null = null;
  private groundFieldTexture: THREE.DataTexture | null = null;
  private decorations = true;

  constructor(readonly domain: Domain) {
    this.root.name = "atmos-root";
    this.scene.add(this.root);
    const { sx, sz, top } = domain;

    const groundMaterial = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(sx, sz).rotateX(-Math.PI / 2),
      groundMaterial,
    );
    this.ground.receiveShadow = true;
    this.ground.userData.pickable = "ground";
    this.ground.renderOrder = 0;
    this.root.add(this.ground);

    // 1 km grid
    const points: number[] = [];
    for (let x = Math.ceil(-sx / 2); x <= sx / 2; x += 1)
      points.push(x, 0.0005, -sz / 2, x, 0.0005, sz / 2);
    for (let z = Math.ceil(-sz / 2); z <= sz / 2; z += 1)
      points.push(-sx / 2, 0.0005, z, sx / 2, 0.0005, z);
    const gridGeometry = new THREE.BufferGeometry();
    gridGeometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    this.grid = new THREE.LineSegments(
      gridGeometry,
      new THREE.LineBasicMaterial({ transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.root.add(this.grid);

    const box = new THREE.BoxGeometry(sx, top, sz).translate(0, top / 2, 0);
    this.frame = new THREE.LineSegments(
      new THREE.EdgesGeometry(box),
      new THREE.LineBasicMaterial({ transparent: true, opacity: 0.45, depthWrite: false }),
    );
    box.dispose();
    this.root.add(this.frame);

    this.hemi = new THREE.HemisphereLight(0xdfeaff, 0x2a3440, 1.35);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
    this.sun.position.set(-9, 14, 6);
    this.sun.target.position.set(0, 0, 0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    const cam = this.sun.shadow.camera;
    cam.left = -13;
    cam.right = 13;
    cam.top = 13;
    cam.bottom = -13;
    cam.near = 1;
    cam.far = 40;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.01;
    this.sun.shadow.radius = 3;
    this.scene.add(this.sun, this.sun.target);
    this.setTheme("dark");
  }

  /** Globe tab: Cesium draws sky and ground, so no background, fog, floor, grid or frame. */
  hideDecorations(): void {
    this.decorations = false;
    this.scene.background = null;
    this.scene.fog = null;
    this.ground.visible = false;
    this.grid.visible = false;
    this.frame.visible = false;
  }

  setTheme(theme: Theme): void {
    const t = THEMES[theme];
    if (this.decorations) {
      this.scene.background = new THREE.Color(t.background);
      this.scene.fog = new THREE.Fog(t.fog, 30, 70);
    }
    if (!this.groundTexture) this.ground.material.color.set(t.ground);
    (this.grid.material as THREE.LineBasicMaterial).color.set(t.grid);
    (this.frame.material as THREE.LineBasicMaterial).color.set(t.frame);
    this.hemi.intensity = theme === "dark" ? 1.35 : 1.6;
  }

  /**
   * Colour the ground with a 2D field (or none). Colours are blended towards the theme
   * ground colour (`strength`) so the map stays readable under buildings and particles.
   */
  setGroundField(
    values: ((i: number) => number) | null,
    range: [number, number],
    colormap: string,
    theme: Theme,
    strength = 0.75,
    /** Value window in physical units; cells outside fall back to the plain floor. */
    filter: [number, number] | null = null,
  ): void {
    this.groundTexture?.dispose();
    this.groundTexture = null;
    this.groundFieldTexture?.dispose();
    this.groundFieldTexture = null;
    const material = this.ground.material;
    if (!values) {
      material.map = null;
      material.color.set(THEMES[theme].ground);
      material.needsUpdate = true;
      return;
    }
    const { nx, ny } = this.domain;
    const lut = colormapBytes(colormap);
    const base = new THREE.Color(THEMES[theme].ground).convertLinearToSRGB();
    const bytes = new Uint8Array(nx * ny * 4);
    const fieldBytes = new Uint8Array(nx * ny * 4);
    // Soft edge just outside the window (1.5% of the colour range) instead of a hard step.
    const band = Math.max(Math.abs(range[1] - range[0]) * 0.015, 1e-9);
    const smooth = (e0: number, e1: number, x: number) => {
      const u = THREE.MathUtils.clamp((x - e0) / (e1 - e0), 0, 1);
      return u * u * (3 - 2 * u);
    };
    for (let i = 0; i < nx * ny; i += 1) {
      const value = values(i);
      if (!Number.isFinite(value)) {
        fieldBytes[i * 4 + 3] = 0;
        bytes[i * 4] = base.r * 255;
        bytes[i * 4 + 1] = base.g * 255;
        bytes[i * 4 + 2] = base.b * 255;
        bytes[i * 4 + 3] = 255;
        continue;
      }
      // Colour mapping stays on the fixed `range`; the filter only masks.
      const t = THREE.MathUtils.clamp((value - range[0]) / (range[1] - range[0] || 1), 0, 1);
      const j = Math.round(t * 255) * 4;
      const lowW = filter && Number.isFinite(filter[0]) ? smooth(filter[0] - band, filter[0], value) : 1;
      const highW = filter && Number.isFinite(filter[1]) ? 1 - smooth(filter[1], filter[1] + band, value) : 1;
      const w = lowW * highW;
      const s = strength * w;
      fieldBytes[i * 4] = lut[j]!;
      fieldBytes[i * 4 + 1] = lut[j + 1]!;
      fieldBytes[i * 4 + 2] = lut[j + 2]!;
      // alpha = in-window weight: building tint fades out with it
      fieldBytes[i * 4 + 3] = Math.round(w * 255);
      bytes[i * 4] = base.r * 255 * (1 - s) + lut[j] * s;
      bytes[i * 4 + 1] = base.g * 255 * (1 - s) + lut[j + 1] * s;
      bytes[i * 4 + 2] = base.b * 255 * (1 - s) + lut[j + 2] * s;
      bytes[i * 4 + 3] = 255;
    }
    // row 0 = southernmost latitude = v 0 = +z after the plane rotation
    const texture = new THREE.DataTexture(bytes, nx, ny, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 8;
    texture.needsUpdate = true;
    this.groundTexture = texture;
    const fieldTexture = new THREE.DataTexture(fieldBytes, nx, ny, THREE.RGBAFormat);
    fieldTexture.colorSpace = THREE.SRGBColorSpace;
    fieldTexture.magFilter = THREE.LinearFilter;
    fieldTexture.minFilter = THREE.LinearMipmapLinearFilter;
    fieldTexture.generateMipmaps = true;
    fieldTexture.anisotropy = 8;
    fieldTexture.needsUpdate = true;
    this.groundFieldTexture = fieldTexture;
    material.map = texture;
    material.color.set(0xffffff);
    material.needsUpdate = true;
  }

  /** Pure colormap texture, without the theme-ground blend used by the floor. */
  getGroundFieldTexture(): THREE.DataTexture | null {
    return this.groundFieldTexture;
  }

  setShadows(on: boolean): void {
    this.sun.castShadow = on;
  }
}

/** Value reader for a decoded 2D variable (physical floats). */
export function field2D(_meta: VariableMeta, data: Float32Array): (i: number) => number {
  return (i) => data[i];
}
