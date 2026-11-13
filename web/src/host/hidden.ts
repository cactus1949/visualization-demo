import type { Object3D } from "three";

/** Runs `draw` with `objects` hidden, then restores each object's own visibility. */
export function withHidden(objects: readonly Object3D[], draw: () => void): void {
  const was = objects.map((o) => o.visible);
  for (const o of objects) o.visible = false;
  try {
    draw();
  } finally {
    objects.forEach((o, i) => (o.visible = was[i]!));
  }
}
