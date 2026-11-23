import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { elementRows, toggleMode } from "./elementMode.ts";

describe("element rows", () => {
  it("puts particles only on horizontal wind, and ground and volume stay separate", () => {
    const rows = elementRows(
      [
        { name: "none", label: "无" },
        { name: "speed0", label: "近地面风速" },
        { name: "t2m", label: "2米气温 (t2m)" },
      ],
      [
        { name: "speed", label: "水平风速" },
        { name: "u_gust", label: "阵风 (u_gust)" },
        { name: "tke", label: "湍动能 (tke)" },
      ],
    );
    assert.equal(rows.filter((row) => row.particles).length, 1);
    assert.equal(rows[0]!.particles, true);
    assert.equal(rows.find((row) => row.id === "t2m")?.volume, null);
    assert.equal(rows.find((row) => row.id === "u_gust")?.ground, null);
    assert.equal(rows.some((row) => row.id === "none" || row.id === "speed0"), false);
  });

  it("replaces the variable of one mode and turns that mode off when the same icon is clicked again", () => {
    const replaced = toggleMode({ on: true, variable: "speed" }, "u_gust");
    assert.deepEqual(replaced, { on: true, variable: "u_gust" });
    const closed = toggleMode(replaced, "u_gust");
    assert.deepEqual(closed, { on: false, variable: "u_gust" });
  });
});
