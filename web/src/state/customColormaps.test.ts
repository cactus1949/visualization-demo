import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCustomColormap,
  deleteCustomColormap,
  loadCustomColormaps,
  parseCustomColormaps,
  saveCustomColormaps,
  stopsToHexString,
  updateCustomColormap,
  type CustomColormap,
} from "./customColormaps.ts";

function memoryStore() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

describe("custom colormaps", () => {
  it("creates, updates, deletes and persists custom colormaps", () => {
    const store = memoryStore();
    const res = createCustomColormap([], "暖风", ["#112233", "#ffaa00", "#ffffff"], 1000);
    assert.ok(res);
    assert.equal(res.created.label, "暖风");
    assert.equal(stopsToHexString(res.created.stops), "112233ffaa00ffffff");

    assert.equal(saveCustomColormaps(store, res.list), true);
    const loaded = loadCustomColormaps(store);
    assert.deepEqual(loaded, res.list);

    const updated = updateCustomColormap(loaded, res.created.id, "暖风改", ["#000000", "#ff0000"]);
    assert.ok(updated);
    assert.equal(updated[0]!.label, "暖风改");
    assert.deepEqual(updated[0]!.stops, ["#000000", "#ff0000"]);

    const remaining = deleteCustomColormap(updated, res.created.id);
    assert.deepEqual(remaining, []);
  });

  it("rejects empty labels or fewer than 2 valid color stops", () => {
    assert.equal(createCustomColormap([], "  ", ["#112233", "#445566"]), null);
    assert.equal(createCustomColormap([], "单色", ["#112233"]), null);
    assert.equal(createCustomColormap([], "无效", ["not-a-color", "#112233"]), null);
    assert.equal(updateCustomColormap([], "missing", "新名", ["#112233", "#445566"]), null);
  });

  it("ignores broken json, wrong version, and duplicate or invalid entries", () => {
    assert.deepEqual(parseCustomColormaps("{bad"), []);
    assert.deepEqual(parseCustomColormaps(JSON.stringify({ v: 99, items: [] })), []);
    const raw = JSON.stringify({
      v: 1,
      items: [
        { id: "c1", label: "正常", stops: ["#112233", "#AABBCC"] },
        { id: "c1", label: "重复", stops: ["#000000", "#ffffff"] },
        { id: "c2", label: "少节点", stops: ["#000000"] },
      ],
    });
    const parsed: CustomColormap[] = parseCustomColormaps(raw);
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0], { id: "c1", label: "正常", stops: ["#112233", "#aabbcc"] });
  });
});
