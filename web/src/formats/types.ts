/**
 * One entry of the top menu = one export format, read from `$WEB_ROOT/<id>/yyyymm/yyyymmdd/`.
 * Every `formats/*.ts` file (except this one) default-exports a FormatDef; App.vue picks them
 * up with import.meta.glob, so deleting a file removes its menu entry.
 */
export interface FormatDef {
  /** directory name under $WEB_ROOT and value of `?format=` */
  id: string;
  label: string;
  order: number;
  /** repo cases under data/web/ to try when no exported day is reachable (no API / no export yet) */
  fallbackCases?: string[];
  /** status text when nothing could be opened */
  missingHint?: string;
}

export function loadFormats(): FormatDef[] {
  const mods = import.meta.glob<{ default: FormatDef }>("./*.ts", { eager: true });
  return Object.values(mods)
    .map((m) => m.default)
    .filter((f): f is FormatDef => !!f && typeof f.id === "string")
    .sort((a, b) => a.order - b.order);
}
