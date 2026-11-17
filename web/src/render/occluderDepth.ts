/**
 * Whether the last occluder-depth image is still valid.
 * A camera move, a target resize, or a scene-generation change misses.
 * The volume colour target is still redrawn every visible frame.
 */

/** Matrix elements quantised to 0.001. Smaller jitter hits; a real camera move misses. */
export function occluderDepthKey(
  view: ArrayLike<number>,
  projection: ArrayLike<number>,
  width: number,
  height: number,
  generation: string,
): string {
  const parts: string[] = [String(width), String(height), generation];
  for (const matrix of [view, projection]) {
    for (let i = 0; i < matrix.length; i += 1) parts.push(String(Math.round(matrix[i]! * 1000) / 1000));
  }
  return parts.join(",");
}

/** Remembers the key of the last occluder-depth image. Call invalidate after a context restore. */
export class OccluderDepthCache {
  private key = "";

  matches(view: ArrayLike<number>, projection: ArrayLike<number>, width: number, height: number, generation: string): boolean {
    return this.key !== "" && this.key === occluderDepthKey(view, projection, width, height, generation);
  }

  remember(view: ArrayLike<number>, projection: ArrayLike<number>, width: number, height: number, generation: string): void {
    this.key = occluderDepthKey(view, projection, width, height, generation);
  }

  invalidate(): void {
    this.key = "";
  }
}
