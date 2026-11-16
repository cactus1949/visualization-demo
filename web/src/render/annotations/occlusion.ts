import * as THREE from "three";

/** Coarse max-height grid in root-local km, for cheap annotation occlusion. */
export class HeightOccluder {
  readonly sx: number;
  readonly sz: number;
  readonly cols: number;
  readonly rows: number;
  private readonly heights: Float32Array;
  private readonly cellX: number;
  private readonly cellZ: number;
  private readonly tmp = new THREE.Vector3();
  private readonly invRoot = new THREE.Matrix4();

  constructor(sx: number, sz: number, cols = 128, rows = 128) {
    this.sx = sx;
    this.sz = sz;
    this.cols = cols;
    this.rows = rows;
    this.heights = new Float32Array(cols * rows);
    this.cellX = sx / cols;
    this.cellZ = sz / rows;
  }

  clear(): void {
    this.heights.fill(0);
  }

  /**
   * Ingest meshes parented under `root`. Heights are stored in root-local km
   * (real height, ignoring the current vertical exaggeration).
   */
  ingestObject(object: THREE.Object3D, root: THREE.Object3D): void {
    // inverse(root.matrixWorld) already removes vertical exaggeration, so we
    // must not temporarily clear root.scale.y (the render loop is running).
    root.updateMatrixWorld(true);
    object.updateMatrixWorld(true);
    this.invRoot.copy(root.matrixWorld).invert();
    const baked = new THREE.Matrix4();
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const pos = mesh.geometry.getAttribute("position");
      if (!pos) return;
      baked.multiplyMatrices(this.invRoot, mesh.matrixWorld);
      for (let i = 0; i < pos.count; i += 1) {
        this.tmp.fromBufferAttribute(pos, i).applyMatrix4(baked);
        this.addSample(this.tmp.x, this.tmp.y, this.tmp.z);
      }
    });
  }

  addSample(x: number, y: number, z: number): void {
    if (y <= 0) return;
    const ix = Math.floor((x / this.sx + 0.5) * this.cols);
    const iz = Math.floor((z / this.sz + 0.5) * this.rows);
    if (ix < 0 || iz < 0 || ix >= this.cols || iz >= this.rows) return;
    const i = iz * this.cols + ix;
    if (y > this.heights[i]) this.heights[i] = y;
  }

  heightKm(x: number, z: number): number {
    const ix = Math.floor((x / this.sx + 0.5) * this.cols);
    const iz = Math.floor((z / this.sz + 0.5) * this.rows);
    if (ix < 0 || iz < 0 || ix >= this.cols || iz >= this.rows) return 0;
    return this.heights[iz * this.cols + ix];
  }

  /**
   * True when the segment from camera (root-local) to the anchor passes under
   * a column taller than the ray (plus a small epsilon of 8 m).
   */
  blocked(cam: THREE.Vector3, anchor: THREE.Vector3): boolean {
    const dx = anchor.x - cam.x;
    const dy = anchor.y - cam.y;
    const dz = anchor.z - cam.z;
    const horiz = Math.hypot(dx, dz);
    if (horiz < 1e-5) return this.heightKm(anchor.x, anchor.z) > anchor.y + 0.008;
    const step = Math.min(this.cellX, this.cellZ);
    const n = Math.min(160, Math.max(6, Math.ceil(horiz / step)));
    // Skip ~250 m from the camera so a viewpoint inside the urban canopy
    // does not mark every annotation as occluded.
    const tStart = Math.min(0.35, 0.25 / horiz);
    let hits = 0;
    for (let i = 1; i < n; i += 1) {
      const t = i / n;
      if (t < tStart || t > 0.96) continue;
      const x = cam.x + dx * t;
      const y = cam.y + dy * t;
      const z = cam.z + dz * t;
      if (this.heightKm(x, z) > y + 0.012) {
        hits += 1;
        if (hits >= 2) return true;
      } else {
        hits = 0;
      }
    }
    return false;
  }
}
