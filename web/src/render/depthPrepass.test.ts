import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Mesh, MeshBasicMaterial, MeshDepthMaterial, Object3D } from "three";
import { withColorWriteDisabled, withDepthStandIns, withoutShadowPass } from "./depthPrepass.ts";

describe("occluder prepass material lifecycle", () => {
  it("turns colour writes off for the draw and restores them, including after a throw", () => {
    const root = new Object3D();
    const material = new MeshBasicMaterial();
    material.colorWrite = true;
    root.add(new Mesh(undefined, material));
    assert.throws(() => withColorWriteDisabled([root], () => {
      assert.equal(material.colorWrite, false);
      throw new Error("draw failed");
    }));
    assert.equal(material.colorWrite, true);
  });

  it("shares one material across meshes and restores the original flag", () => {
    const root = new Object3D();
    const material = new MeshBasicMaterial();
    material.colorWrite = false;
    root.add(new Mesh(undefined, material), new Mesh(undefined, material));
    withColorWriteDisabled([root], () => {
      assert.equal(material.colorWrite, false);
    });
    assert.equal(material.colorWrite, false);
  });

  it("uses the globe depth material when present, and puts the lit material back", () => {
    const root = new Object3D();
    const lit = new MeshBasicMaterial();
    const placed = new MeshDepthMaterial();
    const mesh = new Mesh(undefined, lit);
    mesh.customDepthMaterial = placed;
    const plain = new Mesh(undefined, lit);
    root.add(mesh, plain);
    assert.throws(() => withDepthStandIns([root], () => {
      assert.equal(mesh.material, placed);
      assert.ok((plain.material as MeshDepthMaterial).isMeshDepthMaterial);
      assert.notEqual(plain.material, lit);
      throw new Error("depth failed");
    }));
    assert.equal(mesh.material, lit);
    assert.equal(plain.material, lit);
  });

  it("postpones the shadow pass and restores needsUpdate when the draw throws", () => {
    const renderer = { shadowMap: { needsUpdate: true } };
    assert.throws(() => withoutShadowPass(renderer, () => {
      assert.equal(renderer.shadowMap.needsUpdate, false);
      throw new Error("depth failed");
    }));
    assert.equal(renderer.shadowMap.needsUpdate, true);
  });
});
