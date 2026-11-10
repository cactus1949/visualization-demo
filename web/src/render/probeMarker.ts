import * as THREE from "three";

/** A small weather-station style marker, kept in root-local km coordinates. */
export class ProbeMarker {
  readonly object = new THREE.Group();
  private readonly previewPole: THREE.Mesh;
  private readonly previewHead: THREE.Mesh;
  private readonly fixedPole: THREE.Mesh;
  private readonly fixedHead: THREE.Mesh;

  constructor(top: number) {
    this.object.name = "probe-markers";
    this.object.renderOrder = 20;
    const poleGeometry = new THREE.CylinderGeometry(0.035, 0.055, top, 8);
    const headGeometry = new THREE.SphereGeometry(0.16, 16, 10);
    const preview = new THREE.MeshBasicMaterial({
      color: 0x65e9ff,
      transparent: true,
      opacity: 0.42,
      depthTest: false,
      depthWrite: false,
    });
    const fixed = new THREE.MeshBasicMaterial({
      color: 0xffc247,
      depthTest: false,
      depthWrite: false,
    });
    this.previewPole = new THREE.Mesh(poleGeometry, preview);
    this.previewHead = new THREE.Mesh(headGeometry, preview);
    this.fixedPole = new THREE.Mesh(poleGeometry, fixed);
    this.fixedHead = new THREE.Mesh(headGeometry, fixed);
    for (const mesh of [this.previewPole, this.previewHead, this.fixedPole, this.fixedHead]) {
      mesh.position.y = mesh.geometry === poleGeometry ? top / 2 : top;
      mesh.renderOrder = 21;
      mesh.frustumCulled = false;
    }
    this.object.add(this.previewPole, this.previewHead, this.fixedPole, this.fixedHead);
    this.setVisible(false, false);
  }

  setPreview(x: number, z: number, visible = true): void {
    this.previewPole.position.x = x;
    this.previewPole.position.z = z;
    this.previewHead.position.x = x;
    this.previewHead.position.z = z;
    this.previewPole.visible = visible;
    this.previewHead.visible = visible;
  }

  setPreviewVisible(visible: boolean): void {
    this.previewPole.visible = visible;
    this.previewHead.visible = visible;
  }

  setFixed(x: number, z: number, visible = true): void {
    this.fixedPole.position.x = x;
    this.fixedPole.position.z = z;
    this.fixedHead.position.x = x;
    this.fixedHead.position.z = z;
    this.fixedPole.visible = visible;
    this.fixedHead.visible = visible;
  }

  setVisible(preview: boolean, fixed: boolean): void {
    this.previewPole.visible = preview;
    this.previewHead.visible = preview;
    this.fixedPole.visible = fixed;
    this.fixedHead.visible = fixed;
  }

  dispose(): void {
    this.previewPole.geometry.dispose();
    this.previewHead.geometry.dispose();
    (this.previewPole.material as THREE.Material).dispose();
    (this.fixedPole.material as THREE.Material).dispose();
    this.previewHead.material = this.previewPole.material;
    this.fixedHead.material = this.fixedPole.material;
  }
}
