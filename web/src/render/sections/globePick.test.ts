import { test } from "node:test";
import assert from "node:assert/strict";
import { pickSections, type PickSurface, type Vec3 } from "./globePick.ts";

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
