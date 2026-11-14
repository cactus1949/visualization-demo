import { test } from "node:test";
import assert from "node:assert/strict";
import { globePickSurfaces, pickSections, polylineWalls, type PickSurface, type Vec3 } from "./globePick.ts";

// A curved stand-in for the shell: ENU (km, z up) on a sphere of radius R tangent at the origin,
// box km = (east, AGL, south). Exaggerated curvature (R = 60 km) so a flat-space pick would be wrong.
const R = 60;
const toBox = (p: Vec3): Vec3 => {
  const [x, y, z] = p;
  const cz = z + R;
  const r = Math.hypot(x, y, cz);
  return [R * Math.atan2(x, cz), r - R, -R * Math.atan2(y, cz)];
};
const toEnu = (b: Vec3): Vec3 => {
  const r = R + b[1];
  const ax = b[0] / R, ay = -b[2] / R;
  // inverse of toBox for small angles: direction (tan ax, tan ay, 1) normalised
  const n = Math.hypot(Math.tan(ax), Math.tan(ay), 1);
  return [(r * Math.tan(ax)) / n, (r * Math.tan(ay)) / n, r / n - R];
};

function rayTo(target: Vec3, from: Vec3): { o: Vec3; d: Vec3 } {
  const t = toEnu(target);
  return { o: from, d: [t[0] - from[0], t[1] - from[1], t[2] - from[2]] };
}

const hx = 9, hz = 9, top = 1;

test("round trip of the stand-in mapping", () => {
  const b: Vec3 = [3, 0.4, -2];
  const back = toBox(toEnu(b));
  for (let i = 0; i < 3; i += 1) assert.ok(Math.abs(back[i]! - b[i]!) < 1e-9);
});

test("height section: hit is the section point, not the ground behind it", () => {
  const target: Vec3 = [2.3, 0.5, -1.7];
  const { o, d } = rayTo(target, [-20, -15, 12]);
  const hit = pickSections(o, d, 0, 2, toBox, [{ kind: "height", y: 0.5, hx, hz }]);
  assert.ok(hit);
  assert.ok(Math.abs(hit.t - 1) < 1e-6);
  for (let i = 0; i < 3; i += 1) assert.ok(Math.abs(hit.box[i]! - target[i]!) < 1e-6);
});

test("lon wall and polyline walls: first crossing inside the extent", () => {
  const walls: PickSurface[] = [
    { kind: "wall", ax: -6, az: -4, bx: 0, bz: 3, top },
    { kind: "wall", ax: 0, az: 3, bx: 6, bz: -2, top },
  ];
  const target: Vec3 = [3, 0.6, 0.5]; // on the second wall
  const { o, d } = rayTo(target, [25, -10, 8]);
  const hit = pickSections(o, d, 0, 2, toBox, walls);
  assert.ok(hit);
  assert.equal(hit.index, 1);
  for (let i = 0; i < 3; i += 1) assert.ok(Math.abs(hit.box[i]! - target[i]!) < 1e-6);
});

test("crossing outside the extent or past t1 is ignored", () => {
  const wall: PickSurface = { kind: "wall", ax: -1, az: 0, bx: 1, bz: 0, top };
  const { o, d } = rayTo([5, 0.5, 0], [5, -20, 6]); // crosses the wall's line at x = 5 (outside)
  assert.equal(pickSections(o, d, 0, 2, toBox, [wall]), null);
  const r = rayTo([0, 0.5, 0], [0, -20, 6]);
  assert.equal(pickSections(r.o, r.d, 0, 0.9, toBox, [wall]), null); // ground in front (t1 < hit)
  assert.ok(pickSections(r.o, r.d, 0, 2, toBox, [wall]));
});

test("polylineWalls: one wall per segment, zero-length segments dropped", () => {
  const w = polylineWalls([{ x: -6, z: -4 }, { x: 0, z: 3 }, { x: 0, z: 3 }, { x: 6, z: -2 }], top);
  assert.equal(w.length, 2);
  assert.deepEqual(w[0], { kind: "wall", ax: -6, az: -4, bx: 0, bz: 3, top });
  assert.deepEqual(w[1], { kind: "wall", ax: 0, az: 3, bx: 6, bz: -2, top });
});

test("polyline: nearest wall wins when the ray crosses two walls; a point on the far wall is reached through a gap", () => {
  const walls = polylineWalls([{ x: -6, z: -4 }, { x: 0, z: 3 }, { x: 6, z: -2 }], top);
  // looking from the south (+z) at a point on the first wall: the second wall is not in the way
  const t1: Vec3 = [-3, 0.4, -0.5];
  const r1 = rayTo(t1, [-3, -30, 10]);
  const h1 = pickSections(r1.o, r1.d, 0, 2, toBox, walls);
  assert.ok(h1);
  assert.equal(h1.index, 0);
  for (let i = 0; i < 3; i += 1) assert.ok(Math.abs(h1.box[i]! - t1[i]!) < 1e-6);
  // a ray from inside the V towards the second wall's far side: first crossing is the second wall
  const t2: Vec3 = [3, 0.7, 0.5];
  const r2 = rayTo(t2, [0, 0, 2]);
  const h2 = pickSections(r2.o, r2.d, 0, 2, toBox, walls);
  assert.ok(h2);
  assert.equal(h2.index, 1);
  for (let i = 0; i < 3; i += 1) assert.ok(Math.abs(h2.box[i]! - t2[i]!) < 1e-6);
  // above the wall top: no hit
  const r3 = rayTo([-3, 1.2, -0.5], [-3, -30, 10]);
  assert.equal(pickSections(r3.o, r3.d, 0, 2, toBox, walls), null);
});

test("polylineWalls: fewer than 2 points gives no walls", () => {
  assert.deepEqual(polylineWalls([], top), []);
  assert.deepEqual(polylineWalls([{ x: 1, z: 2 }], top), []);
});

test("globe: a hidden polyline is no longer picked (visible one is)", () => {
  const domain = { sx: 18, sz: 18, top };
  const points = [{ x: -6, z: -4 }, { x: 0, z: 3 }, { x: 6, z: -2 }];
  const target: Vec3 = [-3, 0.4, -0.5];
  const { o, d } = rayTo(target, [-3, -30, 10]);
  const shown = globePickSurfaces({ polyline: { visible: true, points } }, domain);
  assert.equal(shown.length, 2);
  const hit = pickSections(o, d, 0, 2, toBox, shown);
  assert.ok(hit);
  for (let i = 0; i < 3; i += 1) assert.ok(Math.abs(hit.box[i]! - target[i]!) < 1e-6);
  const hidden = globePickSurfaces({ polyline: { visible: false, points } }, domain);
  assert.deepEqual(hidden, []);
  assert.equal(pickSections(o, d, 0, 2, toBox, hidden), null);
  // other sections stay pickable while the polyline is hidden; the hidden walls never block them
  const mixed = globePickSurfaces({ height: { visible: true, y: 0.2 }, polyline: { visible: false, points } }, domain);
  assert.equal(mixed.length, 1);
  const h2 = pickSections(o, d, 0, 2, toBox, mixed);
  assert.ok(h2);
  assert.ok(Math.abs(h2.box[1] - 0.2) < 1e-9);
});
