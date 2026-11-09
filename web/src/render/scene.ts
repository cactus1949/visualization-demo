import * as THREE from "three";
import type { Manifest } from "../data/manifest";
import { worldSize } from "./coords";

export function createScene(
  manifest: Manifest,
  exaggeration: number,
): {
  scene: THREE.Scene;
  root: THREE.Group;
} {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050913);
  scene.fog = new THREE.Fog(0x050913, 12, 40);
  const size = worldSize(manifest, exaggeration);
  const root = new THREE.Group();
  root.name = "atmos";
  scene.add(root);

  const box = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z)),
    new THREE.LineBasicMaterial({ color: 0x38506e, transparent: true, opacity: 0.8 }),
  );
  box.position.y = size.y / 2;
  root.add(box);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(size.x, size.z),
    new THREE.MeshBasicMaterial({ color: 0x14263d, side: THREE.DoubleSide, opacity: 0.8 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.userData.isGround = true;
  root.add(ground);

  const axes = new THREE.AxesHelper(Math.min(size.x, size.z) * 0.22);
  axes.position.set(-size.x / 2, 0.02, size.z / 2);
  root.add(axes);
  return { scene, root };
}
