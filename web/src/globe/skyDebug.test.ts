import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SKY_KEYS, SkyDebugState, normalizeSkyValue, skyKey, type SkyKey, type SkyTarget, type SkyValue } from "./skyDebug.ts";

/** A fake scene: a plain record, with an "app" that rewrites atmosphere / sky like GlobeViewer does. */
function fakeScene(init: Partial<Record<SkyKey, SkyValue>> = {}) {
  const v: Partial<Record<SkyKey, SkyValue>> = {
    skyAtmosphere: true,
    groundAtmosphere: true,
    skyBox: true,
    moon: true,
    backgroundColor: "#000000",
    dynamicAtmosphereLighting: true,
    dynamicAtmosphereLightingFromSun: false,
    ...init,
  };
  const target: SkyTarget = { read: (k) => v[k], write: (k, x) => { v[k] = x; } };
  return { v, target };
}
const isColor = (s: string) => /^#[0-9a-f]{3,8}$/i.test(s) || s === "gray";

describe("sky debug keys and values", () => {
  it("accepts the canonical keys and the property-path aliases", () => {
    for (const k of SKY_KEYS) assert.equal(skyKey(k), k);
    assert.equal(skyKey("showGroundAtmosphere"), "groundAtmosphere");
    assert.equal(skyKey("skyBox.show"), "skyBox");
    assert.equal(skyKey("background"), "backgroundColor");
    assert.throws(() => skyKey("fog"));
  });
  it("normalises Console booleans and colours; null clears", () => {
    assert.equal(normalizeSkyValue("moon", false, isColor), false);
    assert.equal(normalizeSkyValue("moon", "off", isColor), false);
    assert.equal(normalizeSkyValue("moon", 1, isColor), true);
    assert.equal(normalizeSkyValue("moon", null, isColor), null);
    assert.equal(normalizeSkyValue("backgroundColor", " #808080 ", isColor), "#808080");
    assert.throws(() => normalizeSkyValue("backgroundColor", "notacolour", isColor));
    assert.throws(() => normalizeSkyValue("backgroundColor", false, isColor));
    assert.throws(() => normalizeSkyValue("skyBox", "maybe", isColor));
  });
});

describe("sky debug overrides", () => {
  it("an override survives the app's per-frame rewrite (postUpdate or preRender, app first)", () => {
    const { v, target } = fakeScene();
    const s = new SkyDebugState();
    s.set("skyAtmosphere", false, target);
    s.set("backgroundColor", "#808080", target);
    for (let frame = 0; frame < 3; frame++) {
      // app: applyNadirAtmosphere at a mild pitch turns atmosphere back on, applySky (theme change) sets black
      v.skyAtmosphere = true;
      v.groundAtmosphere = true;
      v.backgroundColor = "#000000";
      s.apply(target);
      assert.equal(v.skyAtmosphere, false, "override wins at draw time");
      assert.equal(v.backgroundColor, "#808080");
      assert.equal(v.groundAtmosphere, true, "keys not in the table stay with the app");
    }
    assert.equal(s.applied, 3);
  });
  it("clear() and reset() put the pre-override value back and stop interfering", () => {
    const { v, target } = fakeScene({ dynamicAtmosphereLighting: true });
    const s = new SkyDebugState();
    s.set("dynamicAtmosphereLighting", false, target);
    s.set("dynamicAtmosphereLighting", true, target); // second set must not overwrite the saved original
    s.set("dynamicAtmosphereLighting", false, target);
    s.set("moon", false, target);
    s.set("moon", null, target); // null clears one key
    assert.equal(v.moon, true);
    assert.deepEqual(Object.keys(s.overrides), ["dynamicAtmosphereLighting"]);
    assert.deepEqual(s.reset(target), ["dynamicAtmosphereLighting"]);
    assert.equal(v.dynamicAtmosphereLighting, true);
    assert.deepEqual(s.overrides, {});
    assert.deepEqual(s.saved, {});
    v.skyAtmosphere = false;
    s.apply(target);
    assert.equal(v.skyAtmosphere, false, "after reset the app's value is untouched");
  });
  it("a missing scene object (no skyBox) reads as null and is not restored", () => {
    const { v, target } = fakeScene();
    delete v.skyBox;
    const s = new SkyDebugState();
    assert.equal(s.read(target).skyBox, null);
    s.set("skyBox", false, target);
    s.reset(target);
    assert.equal(s.saved.skyBox, undefined);
  });
});
