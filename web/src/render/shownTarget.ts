/** Cached (a, b, s) of a blended time target (wind, scalars, or derived speed). */
export type ShownTarget = { a: number; b: number; s: number };

/** True when this target already holds the blended field for (a, b, s). */
export function shownIsCurrent(shown: ShownTarget, a: number, b: number, s: number, valid: boolean): boolean {
  return valid && shown.a === a && shown.b === b && shown.s === s;
}

/** Drop the cached (a, b, s) so the next blend of the same time runs again (e.g. after a format switch). */
export function invalidateShown(shown: ShownTarget): void {
  shown.a = -1;
}
