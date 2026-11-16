/**
 * 右下角视角按钮用的纯几何：缩放步长、盒体正北、指北针转角。
 * 盒体坐标 x 东、y 上、z 南；地球 ENU 是 x 东、y 北、z 上，指北针的北向量由调用方传入。
 */

export type Vec3 = readonly [number, number, number];

export type CameraPose = {
  position: [number, number, number];
  target: [number, number, number];
};

/** 拷一份相机姿态，避免和宿主下一次 getView 共用数组。 */
export function clonePose(pose: CameraPose): CameraPose {
  return {
    position: [pose.position[0], pose.position[1], pose.position[2]],
    target: [pose.target[0], pose.target[1], pose.target[2]],
  };
}

/**
 * 把相对注视点的偏移乘上 `scale`（小于 1 靠近），并夹在距离上下限内。
 * 零长度偏移原样返回。
 */
export function scaledOffset(offset: Vec3, scale: number, minDist: number, maxDist: number): [number, number, number] {
  const dist = Math.hypot(offset[0], offset[1], offset[2]);
  if (!(dist > 0) || !(scale > 0)) return [offset[0], offset[1], offset[2]];
  const next = Math.min(maxDist, Math.max(minDist, dist * scale));
  const s = next / dist;
  return [offset[0] * s, offset[1] * s, offset[2] * s];
}

/**
 * 沿视线前进的米数，使当前视距变成 `range * scale`（正值靠近）。结果夹在视距上下限内。
 * 非法输入返回 0。
 */
export function zoomTravelM(range: number, scale: number, minRange: number, maxRange: number): number {
  if (!(range > 0) || !(scale > 0)) return 0;
  const next = Math.min(maxRange, Math.max(minRange, range * scale));
  return range - next;
}

/**
 * 盒体：相机挪到注视点正南，高度和水平距离不变。已经接近正上方时返回 null（没有南北可转）。
 */
export function southOfTarget(position: Vec3, target: Vec3): [number, number, number] | null {
  const dx = position[0] - target[0];
  const dy = position[1] - target[1];
  const dz = position[2] - target[2];
  const horiz = Math.hypot(dx, dz);
  if (horiz < 1e-6) return null;
  return [target[0], target[1] + dy, target[2] + horiz];
}

/**
 * 地理北在屏幕上相对正上方的顺时针角度（度），直接给 CSS / SVG rotate。
 * 北几乎沿着视线（正俯视）时返回 0。
 */
export function northScreenDeg(right: Vec3, up: Vec3, north: Vec3): number {
  const x = north[0] * right[0] + north[1] * right[1] + north[2] * right[2];
  const y = north[0] * up[0] + north[1] * up[1] + north[2] * up[2];
  if (x * x + y * y < 1e-10) return 0;
  return (Math.atan2(x, y) * 180) / Math.PI;
}
