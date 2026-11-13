import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ProxyOptions } from "vite";
import { dataProxy, routePrefixes } from "./vite.config.ts";

const rewrite = (o: ProxyOptions | undefined, p: string): string => (o?.rewrite ? o.rewrite(p) : p);

describe("routePrefixes (data routes follow the vite base)", () => {
  it("root base mounts only /", () => {
    assert.deepEqual(routePrefixes("/"), ["/"]);
    assert.deepEqual(routePrefixes(undefined), ["/"]);
  });
  it("an absolute sub path adds itself (trailing slash optional)", () => {
    assert.deepEqual(routePrefixes("/viz/"), ["/", "/viz/"]);
    assert.deepEqual(routePrefixes("/viz"), ["/", "/viz/"]);
  });
  it("relative or empty bases mount only the root", () => {
    assert.deepEqual(routePrefixes("./"), ["/"]);
    assert.deepEqual(routePrefixes(""), ["/"]);
    assert.deepEqual(routePrefixes("."), ["/"]);
  });
});

describe("dataProxy", () => {
  const target = "http://127.0.0.1:8295";

  it("root base: /api and /data only, paths unchanged", () => {
    const p = dataProxy("/", target);
    assert.deepEqual(Object.keys(p).sort(), ["/api", "/data"]);
    assert.equal(rewrite(p["/api"], "/api/days"), "/api/days");
    assert.equal(p["/data"]?.target, target);
  });

  it("/viz/: four keys; the /viz copies strip the prefix, the root ones keep the path", () => {
    const p = dataProxy("/viz/", target);
    assert.deepEqual(Object.keys(p).sort(), ["/api", "/data", "/viz/api", "/viz/data"]);
    for (const k of Object.keys(p)) assert.equal(p[k]?.target, target);
    assert.equal(rewrite(p["/viz/api"], "/viz/api/days"), "/api/days");
    assert.equal(
      rewrite(p["/viz/data"], "/viz/data/current/202611/20261111/manifest.json"),
      "/data/current/202611/20261111/manifest.json",
    );
    assert.equal(rewrite(p["/api"], "/api/days"), "/api/days");
    assert.equal(rewrite(p["/data"], "/data/x/manifest.json"), "/data/x/manifest.json");
    // a root path that merely looks like the prefix is not touched by the root entries
    assert.equal(rewrite(p["/data"], "/data/viz/a.json"), "/data/viz/a.json");
  });

  it("relative base proxies only the root routes", () => {
    assert.deepEqual(Object.keys(dataProxy("./", target)).sort(), ["/api", "/data"]);
    assert.deepEqual(Object.keys(dataProxy("", target)).sort(), ["/api", "/data"]);
  });
});
