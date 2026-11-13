import type { Object3D } from "three";

/** A section as the probe sees it: its group (visibility) and its surface mesh. */
export interface PickableSection {
  group: { visible: boolean };
  mesh: Object3D;
}

/**
 * First two tabs: probe pick targets are the visible section surface meshes only. Their groups also
 * hold outline LineLoops; three's Line raycast threshold is 1 world unit (1 km here), so picking the
 * group snapped hits near a wall to its top outline (up to ~15 cells off).
 */
export function sectionPickTargets(sections: (PickableSection | null | undefined)[]): Object3D[] {
  const out: Object3D[] = [];
  for (const s of sections) if (s?.group.visible) out.push(s.mesh);
  return out;
}
