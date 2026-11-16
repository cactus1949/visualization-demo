import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  activeLonLatFormat,
  formatLonLat,
  lonLatInBounds,
  nextLonLatFormat,
  setActiveLonLatFormat,
  splitDms,
} from "./lonLatFormat.ts";

describe("lon/lat readout", () => {
  it("interpolates inside the domain and rejects the outside", () => {
    const bounds = { lonMin: 117, lonMax: 118, latMin: 38, latMax: 40 };
    assert.deepEqual(lonLatInBounds(bounds, 0, 0), { lon: 117, lat: 38 });
    assert.deepEqual(lonLatInBounds(bounds, 1, 1), { lon: 118, lat: 40 });
    assert.deepEqual(lonLatInBounds(bounds, 0.5, 0.25), { lon: 117.5, lat: 38.5 });
    assert.equal(lonLatInBounds(bounds, -0.001, 0.5), null);
    assert.equal(lonLatInBounds(bounds, 0.5, 1.001), null);
    assert.equal(lonLatInBounds(bounds, Number.NaN, 0), null);
  });

  it("formats decimal degrees and DMS, including hemisphere and second carry", () => {
    assert.equal(formatLonLat(117.2, 39.9, "decimal"), "117.200000°E  39.900000°N");
    assert.equal(formatLonLat(117.2, 39.9, "dms"), "117°12′00.00″E  39°54′00.00″N");
    assert.equal(formatLonLat(-118.5, -0.5, "decimal"), "118.500000°W  0.500000°S");
    assert.equal(formatLonLat(-118.5, -0.5, "dms"), "118°30′00.00″W  0°30′00.00″S");
    assert.equal(formatLonLat(0, 0, "dms"), "0°00′00.00″E  0°00′00.00″N");
    // 59.995 秒落在四舍五入的边界上，二进制无法精确表示；用明确超过边界的值验收进位。
    assert.deepEqual(splitDms(59.9951 / 3600), { deg: 0, min: 1, sec: 0 });
    assert.deepEqual(splitDms(59.994 / 3600), { deg: 0, min: 0, sec: 59.99 });
    assert.equal(formatLonLat(Number.NaN, 1, "decimal"), "");
  });

  it("toggles the two formats and keeps the choice", () => {
    assert.equal(nextLonLatFormat("decimal"), "dms");
    assert.equal(nextLonLatFormat("dms"), "decimal");
    setActiveLonLatFormat("dms");
    assert.equal(activeLonLatFormat(), "dms");
    setActiveLonLatFormat("decimal");
    assert.equal(activeLonLatFormat(), "decimal");
  });
});
