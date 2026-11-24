import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadVisualPrefs, parseVisualPrefs, saveVisualPrefs, VISUAL_PREFS_KEY, type PrefStore } from "./visualPrefs.ts";

const maps = ["viridis", "turbo"];

function memoryStore(initial: string | null = null, fail = false): PrefStore & { value: string | null } {
  const box = { value: initial };
  return {
    get value() {
      return box.value;
    },
    set value(next: string | null) {
      box.value = next;
    },
    getItem() {
      if (fail) throw new Error("denied");
      return box.value;
    },
    setItem(_key, value) {
      if (fail) throw new Error("denied");
      box.value = value;
    },
    removeItem() {
      if (fail) throw new Error("denied");
      box.value = null;
    },
  };
}

describe("visual preference storage", () => {
  it("keeps an in-range theme and drops an out-of-range opacity and an unknown variable", () => {
    const read = parseVisualPrefs(
      JSON.stringify({
        v: 1,
        theme: "light",
        volumeOpacity: 9,
        particles: { colormap: "nope", opacity: 0.4 },
        groundVar: "not-a-field",
        section: { points: [{ x: 1, z: 2 }] },
      }),
      maps,
    );
    assert.equal(read.message, null);
    assert.equal(read.prefs?.theme, "light");
    assert.equal(read.prefs?.volumeOpacity, 2);
    assert.equal(read.prefs?.particles?.opacity, 0.4);
    assert.equal(read.prefs?.particles?.colormap, undefined);
    assert.equal("groundVar" in (read.prefs ?? {}), false);
  });

  it("ignores broken JSON and a different schema version", () => {
    assert.match(parseVisualPrefs("{", maps).message ?? "", /JSON/);
    assert.match(parseVisualPrefs(JSON.stringify({ v: 0, theme: "dark" }), maps).message ?? "", /版本/);
    assert.equal(parseVisualPrefs(null, maps).prefs, null);
  });

  it("reports a disabled store instead of throwing", () => {
    const denied = memoryStore(null, true);
    const loaded = loadVisualPrefs(denied, maps);
    assert.equal(loaded.prefs, null);
    assert.match(loaded.message ?? "", /不能读取/);
    const saved = saveVisualPrefs(denied, { v: 1, theme: "dark" });
    assert.equal(saved.ok, false);
    assert.match(saved.message, /不能保存/);
  });

  it("round-trips a saved document under the versioned key", () => {
    const store = memoryStore();
    const saved = saveVisualPrefs(store, { v: 1, theme: "dark", volumeOpacity: 0.6 });
    assert.equal(saved.ok, true);
    assert.equal(store.getItem(VISUAL_PREFS_KEY)?.includes('"v":1'), true);
    const loaded = loadVisualPrefs(store, maps);
    assert.equal(loaded.prefs?.theme, "dark");
    assert.equal(loaded.prefs?.volumeOpacity, 0.6);
  });

  it("ignores legacy volumeThreshold and section lowAlpha while preserving hideZero", () => {
    const read = parseVisualPrefs(
      JSON.stringify({
        v: 1,
        volumeOpacity: 1.5,
        volumeThreshold: 0.2,
        volumeHideZero: true,
        sectionStyle: { lowAlpha: true, lowThreshold: 0.15, hideZero: true },
      }),
      maps,
    );
    assert.equal(read.message, null);
    assert.equal(read.prefs?.volumeOpacity, 1.5);
    assert.equal(read.prefs?.volumeHideZero, true);
    assert.equal(read.prefs?.sectionStyle?.hideZero, true);
    assert.equal("volumeThreshold" in (read.prefs ?? {}), false);
    assert.equal("lowAlpha" in (read.prefs?.sectionStyle ?? {}), false);
    assert.equal("lowThreshold" in (read.prefs?.sectionStyle ?? {}), false);
  });
});
