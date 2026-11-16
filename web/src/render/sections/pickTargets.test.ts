import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { sectionPickTargets } from "./pickTargets.ts";

// A lon wall like VerticalSection on the box tab: x = 1.5 km, z in [-9, 9], y in [0, 1], plus its outline.
function wall() {
  const group = new THREE.Group();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([1.5, 0, -9, 1.5, 0, 9, 1.5, 1, 9, 1.5, 1, -9]), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  const ring = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(1.5, 0, -9), new THREE.Vector3(1.5, 0, 9), new THREE.Vector3(1.5, 1, 9), new THREE.Vector3(1.5, 1, -9),
  ]);
  const outline = new THREE.LineLoop(ring, new THREE.LineBasicMaterial());
  group.add(mesh, outline);
  group.updateMatrixWorld(true);
  return { group, mesh };
}

test("only visible section meshes are targets (no outline lines, hidden sections skipped)", () => {
  const a = wall(), b = wall();
  b.group.visible = false;
  const t = sectionPickTargets([a, null, b, undefined]);
  assert.deepEqual(t, [a.mesh]);
});

test("a ray at a wall point 0.6 km below the top hits the wall, not the top outline", () => {
  const w = wall();
  const target = new THREE.Vector3(1.5, 0.4, -2);
  const origin = new THREE.Vector3(14, 12, 16);
  const ray = new THREE.Raycaster(origin, target.clone().sub(origin).normalize());
  // picking the whole group (old behaviour) lands on the outline first
  const old = ray.intersectObjects([w.group], true)[0]!;
  assert.equal(old.object.type, "LineLoop");
  const hit = ray.intersectObjects(sectionPickTargets([w]), true)[0]!;
  assert.equal(hit.object, w.mesh);
  assert.ok(hit.point.distanceTo(target) < 1e-4);
});
