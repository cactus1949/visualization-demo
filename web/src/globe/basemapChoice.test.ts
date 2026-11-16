import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickBasemapSource, tiandituLayers, tiandituUrl } from "./basemapChoice.ts";

describe("globe basemap choice", () => {
  it("production build always uses Tianditu, even when the dev Esri flag or query is set", () => {
    assert.equal(pickBasemapSource({ dev: false, devFlag: "esri", query: "esri" }), "tianditu");
  });
  it("dev uses Tianditu unless Esri is asked for explicitly", () => {
    assert.equal(pickBasemapSource({ dev: true }), "tianditu");
    assert.equal(pickBasemapSource({ dev: true, devFlag: "esri" }), "esri-dev");
    assert.equal(pickBasemapSource({ dev: true, query: "esri" }), "esri-dev");
    assert.equal(pickBasemapSource({ dev: true, devFlag: "other", query: null }), "tianditu");
  });
  it("imagery pairs with the imagery annotations, vector with the vector annotations", () => {
    assert.deepEqual(tiandituLayers("img"), ["img", "cia"]);
    assert.deepEqual(tiandituLayers("vec"), ["vec", "cva"]);
  });
  it("Tianditu URL is the Web-Mercator DataServer template with subdomain and key", () => {
    assert.equal(
      tiandituUrl("img", "abc"),
      "https://t{s}.tianditu.gov.cn/DataServer?T=img_w&x={x}&y={y}&l={z}&tk=abc",
    );
  });
});
