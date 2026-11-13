import * as THREE from "three";
import {
  ANNOTATION_TOKENS as T,
  type AnnotationKind,
  type AnnotationRole,
  type AnnotationState,
} from "./tokens";
import { HeightOccluder } from "./occlusion";
import "./annotations.css";

export type Vec3 = { x: number; y: number; z: number };

export interface AnnotationDesc {
  kind: AnnotationKind;
  anchor: Vec3;
  visible?: boolean;
  state?: AnnotationState;
  role?: AnnotationRole;
  text?: string;
  /** Second point of a vertical stem, in root-local km. */
  stemTo?: Vec3;
  /** Draw a ground ring under the anchor's (x, z) at y = 0. */
  ring?: boolean;
  /** Short leader in CSS px from the anchor to the label (labels only). */
  leader?: boolean | number;
  /** Screen-space direction the label is pushed, default away from `awayFrom`. */
  awayFrom?: Vec3;
  priority?: number;
  draggable?: boolean;
  userData?: unknown;
  /** Handle shape: default circular dot, or a pill grip with an axis icon. */
  variant?: "dot" | "grip";
  /** Drag axis for grip handles: horizontal (x/z/h) or vertical (y/v). */
  axis?: "x" | "y" | "z" | "h" | "v";
  /** Optional group id used to decimate overlapping labels (e.g. box height labels). */
  cluster?: string;
  /** Optional analytic test for handle occlusion in root-local coordinates. */
  occlusionTest?: (camLocal: THREE.Vector3, anchor: THREE.Vector3) => boolean;
  /**
   * "box": anchor / stemTo / awayFrom are first-two-tab box km even when the layer runs in "enu"
   * (globe sections); they go through setBoxPlacement() every update, so k / terrain changes follow.
   * Ignored without a box placement (box tabs).
   */
  space?: "box";
}

/** Globe: box km -> scene frame (exact placement) and back (camera position for analytic tests). */
export interface BoxPlacement {
  toFrame(p: Vec3): Vec3;
  toBox(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
}

export interface AnnotationHit {
  id: string;
  kind: AnnotationKind;
  userData: unknown;
  draggable: boolean;
}

interface PolygonItem {
  anchors: readonly Vec3[];
  space?: "box";
  el: SVGGElement;
  halo: SVGPolygonElement;
  face: SVGPolygonElement;
  points: string;
  visible: boolean;
}

interface Item {
  id: string;
  desc: AnnotationDesc;
  el: HTMLElement;
  line: SVGLineElement | null;
  ring: SVGPolygonElement | null;
  sx: number;
  sy: number;
  lx: number;
  ly: number;
  occluded: boolean;
  onScreen: boolean;
  width: number;
  height: number;
}

const tmpLocal = new THREE.Vector3();
const tmpWorld = new THREE.Vector3();
const tmpCam = new THREE.Vector3();
const tmpAnchor = new THREE.Vector3();
const tmpNdc = new THREE.Vector3();
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

function fill(v: THREE.Vector3, p: Vec3): THREE.Vector3 {
  return v.set(p.x, p.y, p.z);
}

function roleColor(role: AnnotationRole | undefined, state: AnnotationState): string {
  if (state === "disabled") return T.colors.disabled;
  if (role === "fixed" || state === "active") return T.colors.fixed;
  if (role === "preview" || state === "hover") return T.colors.preview;
  if (state === "dragging") return T.colors.active;
  return T.colors.preview;
}

function scaleFor(state: AnnotationState): number {
  if (state === "dragging") return T.sizes.draggingScale;
  if (state === "hover" || state === "selected") return T.sizes.hoverScale;
  return 1;
}

export class AnnotationLayer {
  readonly element: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly root: THREE.Object3D;
  private readonly items = new Map<string, Item>();
  private readonly polygons = new Map<string, PolygonItem>();
  private readonly polygonMatrix = new THREE.Matrix4();
  private readonly clipA = Array.from({ length: 8 }, () => new THREE.Vector4());
  private readonly clipB = Array.from({ length: 8 }, () => new THREE.Vector4());
  private occluder: HeightOccluder | null = null;
  private occluderEnabled = true;
  /** How root-local anchors are interpreted. Box tabs stay on "box"; the globe uses centre-ENU. */
  private coordinates: "box" | "enu" = "box";
  private occlusionAdapter: ((camLocal: THREE.Vector3, anchor: THREE.Vector3) => boolean) | null = null;
  private frame = 0;
  private lastCam = new THREE.Vector3();
  private readonly camLocal = new THREE.Vector3();
  private boxPlacement: BoxPlacement | null = null;
  private readonly camBox = new THREE.Vector3();

  constructor(container: HTMLElement, root: THREE.Object3D) {
    this.root = root;
    this.element = document.createElement("div");
    this.element.className = "anno-overlay";
    this.element.setAttribute("aria-hidden", "true");
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.element.appendChild(this.svg);
    container.appendChild(this.element);
  }

  setOccluder(occluder: HeightOccluder | null, enabled = true): void {
    this.occluder = occluder;
    this.occluderEnabled = enabled;
  }

  setOcclusionEnabled(on: boolean): void {
    this.occluderEnabled = on;
  }

  /**
   * "box": x east, y height, z south, ground rings at y = 0 (first two tabs).
   * "enu": x east, y north, z up, ground rings in the xy plane at the anchor (globe).
   */
  setCoordinateFrame(frame: "box" | "enu"): void {
    this.coordinates = frame;
  }

  /** Globe: how `space: "box"` items reach the scene frame (null: box tabs, anchors used as given). */
  setBoxPlacement(placement: BoxPlacement | null): void {
    this.boxPlacement = placement;
  }

  /** desc with box-km points mapped into the layer frame (same object when nothing to map). */
  private placed(desc: AnnotationDesc): AnnotationDesc {
    const bp = this.boxPlacement;
    if (!bp || desc.space !== "box") return desc;
    return {
      ...desc,
      anchor: bp.toFrame(desc.anchor),
      stemTo: desc.stemTo ? bp.toFrame(desc.stemTo) : undefined,
      awayFrom: desc.awayFrom ? bp.toFrame(desc.awayFrom) : undefined,
    };
  }

  /** Optional occlusion test in the same coordinates as the anchors (globe ENU → box occluder). */
  setOcclusionAdapter(fn: ((camLocal: THREE.Vector3, anchor: THREE.Vector3) => boolean) | null): void {
    this.occlusionAdapter = fn;
  }

  /** Debug: per-item state after the last update (ids, anchors, occlusion). */
  debugItems(): { id: string; kind: string; occluded: boolean; onScreen: boolean; anchor: { x: number; y: number; z: number }; stemTo: { x: number; y: number; z: number } | null }[] {
    return [...this.items.values()].map((it) => ({
      id: it.id,
      kind: it.desc.kind,
      occluded: it.occluded,
      onScreen: it.onScreen,
      anchor: { ...it.desc.anchor },
      stemTo: it.desc.stemTo ? { ...it.desc.stemTo } : null,
    }));
  }

  addMarker(id: string, desc: Omit<AnnotationDesc, "kind">): void {
    this.upsert(id, { ...desc, kind: "marker" });
  }

  addLabel(id: string, desc: Omit<AnnotationDesc, "kind">): void {
    this.upsert(id, { ...desc, kind: "label" });
  }

  addHandle(id: string, desc: Omit<AnnotationDesc, "kind">): void {
    this.upsert(id, { ...desc, kind: "handle" });
  }

  /** Ground selection overlay, always above the scene, with CSS-pixel strokes. */
  addPolygon(id: string, anchors: readonly Vec3[], role: AnnotationRole, space?: "box"): void {
    let item = this.polygons.get(id);
    if (!item) {
      const el = document.createElementNS(this.svg.namespaceURI, "g") as SVGGElement;
      el.classList.add("anno-polygon");
      const halo = this.makeRing();
      halo.setAttribute("stroke", T.colors.outlineHalo);
      halo.setAttribute("stroke-width", String(T.sizes.boxHaloPx));
      const face = this.makeRing();
      face.setAttribute("stroke-width", String(T.sizes.boxOutlinePx));
      face.setAttribute("fill-opacity", String(T.opacity.boxFill));
      for (const polygon of [halo, face]) polygon.setAttribute("stroke-linejoin", "round");
      el.append(halo, face);
      this.svg.prepend(el);
      item = { anchors, el, halo, face, points: "", visible: true };
      this.polygons.set(id, item);
    }
    item.anchors = anchors;
    item.space = space;
    const color = roleColor(role, "idle");
    item.face.setAttribute("stroke", color);
    item.face.setAttribute("fill", color);
  }

  set(id: string, patch: Partial<AnnotationDesc>): void {
    const item = this.items.get(id);
    if (!item) return;
    Object.assign(item.desc, patch);
    this.styleItem(item);
    if (patch.text !== undefined && item.desc.kind === "label") {
      if (item.el.textContent !== patch.text) item.el.textContent = patch.text;
    }
  }

  setState(id: string, state: AnnotationState): void {
    this.set(id, { state });
  }

  setVisible(id: string, visible: boolean): void {
    const polygon = this.polygons.get(id);
    if (polygon) polygon.visible = visible;
    this.set(id, { visible });
  }

  remove(id: string): void {
    this.polygons.get(id)?.el.remove();
    this.polygons.delete(id);
    const item = this.items.get(id);
    if (!item) return;
    item.el.remove();
    item.line?.remove();
    item.ring?.remove();
    this.items.delete(id);
  }

  removePrefixed(prefix: string): void {
    for (const id of [...this.items.keys(), ...this.polygons.keys()]) {
      if (id.startsWith(prefix)) this.remove(id);
    }
  }

  dispose(): void {
    for (const id of [...this.items.keys(), ...this.polygons.keys()]) this.remove(id);
    this.element.remove();
  }

  pick(clientX: number, clientY: number): AnnotationHit | null {
    const rect = this.element.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const r = T.sizes.hitTargetPx * 0.5;
    let best: AnnotationHit | null = null;
    let bestD = r;
    for (const item of this.items.values()) {
      if (item.desc.kind !== "handle") continue;
      if (item.desc.visible === false || !item.onScreen) continue;
      if (item.desc.state === "disabled") continue;
      let hit = false;
      let d = Math.hypot(x - item.sx, y - item.sy);
      if (item.desc.variant === "grip") {
        const hw = Math.max(T.sizes.gripHitPx, item.width || T.sizes.gripWidthPx) * 0.5 + 2;
        const hh = Math.max(T.sizes.gripHeightPx + 8, item.height || T.sizes.gripHeightPx) * 0.5 + 2;
        hit = Math.abs(x - item.sx) <= hw && Math.abs(y - item.sy) <= hh;
        // Prefer the closer grip when several overlap, but still allow a rectangular hit.
        d = hit ? Math.min(d, Math.max(Math.abs(x - item.sx) / hw, Math.abs(y - item.sy) / hh) * r) : d;
      } else {
        hit = d <= r;
      }
      if (hit && d <= bestD) {
        bestD = d;
        best = {
          id: item.id,
          kind: item.desc.kind,
          userData: item.desc.userData,
          draggable: Boolean(item.desc.draggable),
        };
      }
    }
    return best;
  }

  update(camera: THREE.Camera): void {
    this.frame += 1;
    const rect = this.element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    let hasAnalyticOcclusion = false;
    if (this.occluderEnabled) {
      for (const item of this.items.values()) {
        if (item.desc.occlusionTest) {
          hasAnalyticOcclusion = true;
          break;
        }
      }
    }
    const checkOcc =
      this.occluderEnabled &&
      (this.occluder !== null || this.occlusionAdapter !== null) &&
      (this.frame % 4 === 1 || camera.position.distanceToSquared(this.lastCam) > 1e-6);
    if (this.occluderEnabled && (this.occluder !== null || this.occlusionAdapter !== null || hasAnalyticOcclusion)) {
      this.camLocal.copy(camera.position);
      this.root.worldToLocal(this.camLocal);
      if (checkOcc) this.lastCam.copy(camera.position);
      if (this.boxPlacement) this.boxPlacement.toBox(this.camLocal, this.camBox);
    }

    this.polygonMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(this.root.matrixWorld);
    for (const polygon of this.polygons.values()) this.projectPolygon(polygon, rect);

    const labels: Item[] = [];
    for (const item of this.items.values()) {
      this.projectItem(item, camera, rect, checkOcc);
      if (item.desc.kind === "label" && item.onScreen && item.desc.visible !== false) labels.push(item);
    }
    this.decimateClusters(labels);
    this.resolveOverlap(labels.filter((item) => item.onScreen && item.desc.visible !== false));
  }

  private projectPolygon(item: PolygonItem, rect: DOMRect): void {
    let input = this.clipA;
    let output = this.clipB;
    let count = Math.min(item.anchors.length, 4);
    for (let i = 0; i < count; i += 1) {
      const p = item.space === "box" && this.boxPlacement ? this.boxPlacement.toFrame(item.anchors[i]!) : item.anchors[i]!;
      input[i]!.set(p.x, p.y, p.z, 1).applyMatrix4(this.polygonMatrix);
    }
    // Clip near/far in homogeneous space so zooming through a corner does not
    // hide the entire rectangle. The overlay viewport clips its screen edges.
    for (const sign of [1, -1]) {
      let nextCount = 0;
      for (let i = 0; i < count; i += 1) {
        const a = input[(i + count - 1) % count]!;
        const b = input[i]!;
        const da = a.w + sign * a.z;
        const db = b.w + sign * b.z;
        if ((da >= 0) !== (db >= 0)) output[nextCount++]!.copy(a).lerp(b, da / (da - db));
        if (db >= 0) output[nextCount++]!.copy(b);
      }
      count = nextCount;
      [input, output] = [output, input];
    }
    item.el.style.display = item.visible && count >= 3 ? "" : "none";
    if (!item.visible || count < 3) return;
    let points = "";
    for (let i = 0; i < count; i += 1) {
      const p = input[i]!;
      points += `${(rect.width * (p.x / p.w + 1) / 2).toFixed(1)},${(rect.height * (1 - p.y / p.w) / 2).toFixed(1)} `;
    }
    if (points !== item.points) {
      item.halo.setAttribute("points", points);
      item.face.setAttribute("points", points);
      item.points = points;
    }
  }

  private upsert(id: string, desc: AnnotationDesc): void {
    let item = this.items.get(id);
    if (!item) {
      const el = document.createElement("div");
      const line = desc.stemTo || desc.leader || desc.kind === "label" ? this.makeLine() : null;
      const ring = desc.ring ? this.makeRing() : null;
      if (line) this.svg.appendChild(line);
      if (ring) this.svg.appendChild(ring);
      this.element.appendChild(el);
      item = {
        id,
        desc: { ...desc },
        el,
        line,
        ring,
        sx: 0,
        sy: 0,
        lx: 0,
        ly: 0,
        occluded: false,
        onScreen: false,
        width: 0,
        height: 0,
      };
      this.items.set(id, item);
    } else {
      const next = { ...item.desc, ...desc };
      if ((next.stemTo || next.leader || next.kind === "label") && !item.line) {
        item.line = this.makeLine();
        this.svg.appendChild(item.line);
      }
      if (next.ring && !item.ring) {
        item.ring = this.makeRing();
        this.svg.appendChild(item.ring);
      }
      if (!next.ring && item.ring) {
        item.ring.remove();
        item.ring = null;
      }
      item.desc = next;
    }
    this.styleItem(item);
    if (item.desc.kind === "label" && item.el.textContent !== (item.desc.text ?? "")) item.el.textContent = item.desc.text ?? "";
  }

  private makeLine(): SVGLineElement {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("stroke", T.colors.stem);
    line.setAttribute("stroke-width", String(T.sizes.stemWidthPx));
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("fill", "none");
    return line;
  }

  private makeRing(): SVGPolygonElement {
    const ring = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    ring.setAttribute("fill", "none");
    ring.setAttribute("stroke-width", String(T.sizes.ringStrokePx));
    return ring;
  }

  private styleItem(item: Item): void {
    const { desc } = item;
    const state = desc.state ?? "idle";
    const color = roleColor(desc.role, state);
    const grip = desc.kind === "handle" && desc.variant === "grip";
    item.el.className =
      (desc.kind === "label" ? "anno-label" : grip ? "anno-grip" : "anno-dot") +
      (desc.kind === "handle" ? " is-handle" : "") +
      (state === "selected" || state === "dragging" ? " is-selected" : "") +
      (state === "dragging" ? " is-dragging" : "") +
      (state === "disabled" ? " is-disabled" : "");
    if (desc.kind === "label") {
      item.el.style.background = T.colors.labelBackground;
      item.el.style.color = T.colors.labelText;
    } else if (grip) {
      item.el.style.width = `${T.sizes.gripWidthPx}px`;
      item.el.style.height = `${T.sizes.gripHeightPx}px`;
      item.el.style.background = color;
      item.width = T.sizes.gripWidthPx;
      item.height = T.sizes.gripHeightPx;
      const vertical = desc.axis === "y" || desc.axis === "v";
      const icon = vertical ? "↕" : "↔";
      let iconEl = item.el.querySelector(".anno-grip-icon") as HTMLElement | null;
      if (!iconEl) {
        item.el.textContent = "";
        iconEl = document.createElement("span");
        iconEl.className = "anno-grip-icon";
        item.el.appendChild(iconEl);
      }
      if (iconEl.textContent !== icon) iconEl.textContent = icon;
    } else {
      const d = desc.kind === "handle" ? T.sizes.handlePx : T.sizes.markerPx;
      item.el.style.width = `${d}px`;
      item.el.style.height = `${d}px`;
      item.el.style.background = color;
      item.width = d;
      item.height = d;
    }
    if (item.ring) item.ring.setAttribute("stroke", color);
    // Resetting className must not resurrect labels that the last update() hid
    // (decimation / overlap / off-screen). Rebuilds during a drag run from Vue
    // watchers after update(), so the browser would otherwise paint every label,
    // unpositioned, until the next frame. New items stay hidden until projected.
    if (desc.visible === false || !item.onScreen) item.el.classList.add("anno-hidden");
  }

  private projectToScreen(
    local: THREE.Vector3,
    camera: THREE.Camera,
    rect: DOMRect,
    out: THREE.Vector3,
  ): boolean {
    tmpWorld.copy(local);
    this.root.localToWorld(tmpWorld);
    tmpNdc.copy(tmpWorld).project(camera);
    if (tmpNdc.z < -1 || tmpNdc.z > 1) return false;
    out.set((tmpNdc.x * 0.5 + 0.5) * rect.width, (-tmpNdc.y * 0.5 + 0.5) * rect.height, tmpNdc.z);
    return true;
  }

  private projectItem(item: Item, camera: THREE.Camera, rect: DOMRect, checkOcc: boolean): void {
    const desc = this.placed(item.desc);
    if (desc.visible === false) {
      this.hide(item);
      return;
    }
    fill(tmpLocal, desc.anchor);
    if (!this.projectToScreen(tmpLocal, camera, rect, tmpA)) {
      this.hide(item);
      return;
    }
    const margin = 40;
    const on = tmpA.x >= -margin && tmpA.x <= rect.width + margin && tmpA.y >= -margin && tmpA.y <= rect.height + margin;
    if (!on) {
      this.hide(item);
      return;
    }
    item.onScreen = true;
    item.sx = tmpA.x;
    item.sy = tmpA.y;

    fill(tmpAnchor, desc.anchor);
    // For a stem, test mid-height so a blocked ground point does not hide the mast.
    if (desc.stemTo) {
      if (this.coordinates === "enu") {
        tmpAnchor.x = desc.anchor.x * 0.65 + desc.stemTo.x * 0.35;
        tmpAnchor.y = desc.anchor.y * 0.65 + desc.stemTo.y * 0.35;
        tmpAnchor.z = desc.anchor.z * 0.65 + desc.stemTo.z * 0.35;
      } else {
        tmpAnchor.y = (desc.anchor.y + desc.stemTo.y) * 0.35;
      }
    }
    if (desc.kind === "handle") {
      // analytic tests are written in box km: give them the box-space camera on the globe
      const boxed = item.desc.space === "box" && this.boxPlacement !== null;
      const cam = boxed ? this.camBox : this.camLocal;
      const anchor = boxed ? fill(tmpB, item.desc.anchor) : tmpAnchor;
      item.occluded = Boolean(this.occluderEnabled && desc.occlusionTest?.(cam, anchor));
      if (checkOcc && this.occluder && desc.occlusionTest) {
        item.occluded = item.occluded || this.occluder.blocked(cam, anchor);
      }
    } else if (this.occluderEnabled && this.occlusionAdapter) {
      if (checkOcc || this.frame % 4 === 1) item.occluded = this.occlusionAdapter(this.camLocal, tmpAnchor);
    } else if (checkOcc && this.occluder) {
      item.occluded = this.occluder.blocked(this.camLocal, tmpAnchor);
    }

    const state = desc.state ?? "idle";
    let opacity: number = T.opacity.idle;
    if (desc.role === "preview" && state === "idle") opacity = T.opacity.preview;
    if (state === "disabled") opacity = T.opacity.disabled;
    if (item.occluded) opacity *= T.opacity.occluded;
    item.el.style.opacity = String(opacity);
    item.el.classList.remove("anno-hidden");

    let lx = item.sx;
    let ly = item.sy;
    if (desc.kind === "label") {
      const lead = desc.leader === false ? 0 : typeof desc.leader === "number" ? desc.leader : T.sizes.leaderPx;
      let dx = 10;
      let dy = -10;
      if (desc.awayFrom) {
        fill(tmpLocal, desc.awayFrom);
        if (this.projectToScreen(tmpLocal, camera, rect, tmpB)) {
          dx = item.sx - tmpB.x;
          dy = item.sy - tmpB.y;
          const len = Math.hypot(dx, dy) || 1;
          dx = (dx / len) * lead;
          dy = (dy / len) * lead;
        }
      } else {
        const len = Math.hypot(dx, dy);
        dx = (dx / len) * lead;
        dy = (dy / len) * lead;
      }
      lx = item.sx + dx;
      ly = item.sy + dy;
      item.width = item.el.offsetWidth || item.width || (desc.text ? desc.text.length * 6.6 + 12 : 48);
      item.height = item.el.offsetHeight || item.height || 18;
    }
    item.lx = lx;
    item.ly = ly;

    const s = scaleFor(state);
    const tx = desc.kind === "label" ? lx : item.sx;
    const ty = desc.kind === "label" ? ly : item.sy;
    item.el.style.transform = `translate(-50%, -50%) translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${s})`;

    if (item.line) {
      if (desc.stemTo) {
        fill(tmpLocal, desc.stemTo);
        if (this.projectToScreen(tmpLocal, camera, rect, tmpB)) {
          item.line.setAttribute("x1", item.sx.toFixed(1));
          item.line.setAttribute("y1", item.sy.toFixed(1));
          item.line.setAttribute("x2", tmpB.x.toFixed(1));
          item.line.setAttribute("y2", tmpB.y.toFixed(1));
          item.line.setAttribute("stroke", roleColor(desc.role, state));
          item.line.setAttribute("stroke-opacity", String(Math.max(0.55, opacity)));
          item.line.style.display = "";
        } else {
          item.line.style.display = "none";
        }
      } else if (desc.kind === "label") {
        item.line.setAttribute("x1", item.sx.toFixed(1));
        item.line.setAttribute("y1", item.sy.toFixed(1));
        item.line.setAttribute("x2", lx.toFixed(1));
        item.line.setAttribute("y2", ly.toFixed(1));
        item.line.setAttribute("stroke-opacity", String(opacity));
        item.line.style.display = "";
      } else {
        item.line.style.display = "none";
      }
    }

    if (item.ring) this.updateRing(item, camera, rect, opacity);
  }

  private updateRing(item: Item, camera: THREE.Camera, rect: DOMRect, opacity: number): void {
    const ring = item.ring!;
    const a = this.placed(item.desc).anchor;
    const enu = this.coordinates === "enu";
    // box: ring in the y = 0 (xz) ground plane; enu: ring in the local horizontal (xy) at the anchor.
    const at = (dx: number, dz: number) =>
      enu ? { x: a.x + dx, y: a.y + dz, z: a.z } : { x: a.x + dx, y: 0, z: a.z + dz };
    fill(tmpLocal, at(0, 0));
    if (!this.projectToScreen(tmpLocal, camera, rect, tmpA)) {
      ring.style.display = "none";
      return;
    }
    const trial = 0.06;
    fill(tmpLocal, at(trial, 0));
    this.projectToScreen(tmpLocal, camera, rect, tmpB);
    const rx = Math.hypot(tmpB.x - tmpA.x, tmpB.y - tmpA.y);
    fill(tmpLocal, at(0, trial));
    this.projectToScreen(tmpLocal, camera, rect, tmpB);
    const rz = Math.hypot(tmpB.x - tmpA.x, tmpB.y - tmpA.y);
    const mean = 0.5 * (rx + rz) || 1e-6;
    const worldR = trial * ((T.sizes.ringDiameterPx * 0.5) / mean);
    const pts: string[] = [];
    const n = 24;
    for (let i = 0; i < n; i += 1) {
      const ang = (i / n) * Math.PI * 2;
      fill(tmpLocal, at(Math.cos(ang) * worldR, Math.sin(ang) * worldR));
      if (!this.projectToScreen(tmpLocal, camera, rect, tmpB)) continue;
      pts.push(`${tmpB.x.toFixed(1)},${tmpB.y.toFixed(1)}`);
    }
    if (pts.length < 8) {
      ring.style.display = "none";
      return;
    }
    ring.setAttribute("points", pts.join(" "));
    ring.setAttribute("stroke-opacity", String(opacity));
    ring.style.display = "";
  }

  private hide(item: Item): void {
    item.onScreen = false;
    item.el.classList.add("anno-hidden");
    if (item.line) item.line.style.display = "none";
    if (item.ring) item.ring.style.display = "none";
  }

  private decimateClusters(labels: Item[]): void {
    const groups = new Map<string, Item[]>();
    for (const item of labels) {
      const key = item.desc.cluster;
      if (!key) continue;
      let list = groups.get(key);
      if (!list) {
        list = [];
        groups.set(key, list);
      }
      list.push(item);
    }
    const minPx = 28;
    for (const list of groups.values()) {
      if (list.length <= 2) continue;
      list.sort((a, b) => (a.desc.priority ?? 0) - (b.desc.priority ?? 0));
      const first = list[0]!;
      const last = list[list.length - 1]!;
      let lastKeptSy = first.sy;
      for (let i = 1; i < list.length - 1; i += 1) {
        const item = list[i]!;
        const gapPrev = Math.abs(item.sy - lastKeptSy);
        const gapLast = Math.abs(item.sy - last.sy);
        if (gapPrev >= minPx && gapLast >= minPx) {
          lastKeptSy = item.sy;
        } else {
          this.hide(item);
        }
      }
    }
  }

  private resolveOverlap(labels: Item[]): void {
    labels.sort((a, b) => (b.desc.priority ?? 0) - (a.desc.priority ?? 0));
    const placed: Item[] = [];
    for (const item of labels) {
      let ox = 0;
      let oy = 0;
      const dx = item.lx - item.sx;
      const dy = item.ly - item.sy;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      let hidden = false;
      for (let step = 0; step < 6; step += 1) {
        ox = ux * step * 8;
        oy = uy * step * 8;
        const cx = item.lx + ox;
        const cy = item.ly + oy;
        const hit = placed.some((p) => overlaps(cx, cy, item.width, item.height, p.lx, p.ly, p.width, p.height));
        if (!hit) break;
        if (step === 5) hidden = true;
      }
      if (hidden) {
        this.hide(item);
        continue;
      }
      item.lx += ox;
      item.ly += oy;
      const s = scaleFor(item.desc.state ?? "idle");
      item.el.style.transform = `translate(-50%, -50%) translate(${item.lx.toFixed(1)}px, ${item.ly.toFixed(1)}px) scale(${s})`;
      if (item.line) {
        item.line.setAttribute("x2", item.lx.toFixed(1));
        item.line.setAttribute("y2", item.ly.toFixed(1));
      }
      placed.push(item);
    }
  }
}

function overlaps(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): boolean {
  return Math.abs(ax - bx) * 2 < aw + bw + 4 && Math.abs(ay - by) * 2 < ah + bh + 2;
}
