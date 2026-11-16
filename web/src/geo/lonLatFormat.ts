/**
 * 鼠标经纬度读数。点击在十进制度和度分秒之间切换。
 * 盒体视图只在数据范围（u、v ∈ [0, 1]）内有读数。
 */

export const LONLAT_FORMATS = ["decimal", "dms"] as const;
export type LonLatFormat = (typeof LONLAT_FORMATS)[number];

export interface LonLat {
  lon: number;
  lat: number;
}

export interface LonLatBounds {
  lonMin: number;
  lonMax: number;
  latMin: number;
  latMax: number;
}

const DECIMAL_DIGITS = 6;
const SECOND_DIGITS = 2;

/** 记住当前读数形式，视图重挂（例如开关 Cesium）后仍沿用。 */
let activeFormat: LonLatFormat = "decimal";

export function activeLonLatFormat(): LonLatFormat {
  return activeFormat;
}

export function setActiveLonLatFormat(format: LonLatFormat): void {
  activeFormat = format;
}

export function nextLonLatFormat(format: LonLatFormat): LonLatFormat {
  return format === "decimal" ? "dms" : "decimal";
}

export function lonLatFormatHint(format: LonLatFormat): string {
  return format === "decimal" ? "十进制度，点击切换为度分秒" : "度分秒，点击切换为十进制度";
}

/** u、v 在数据范围内（含边界）时线性换算经纬度，范围外返回 null。 */
export function lonLatInBounds(bounds: LonLatBounds, u: number, v: number): LonLat | null {
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return {
    lon: bounds.lonMin + u * (bounds.lonMax - bounds.lonMin),
    lat: bounds.latMin + v * (bounds.latMax - bounds.latMin),
  };
}

interface DmsParts {
  deg: number;
  min: number;
  sec: number;
}

/** 绝对角度拆成度分秒。秒保留两位小数，满 60 进位。 */
export function splitDms(absDeg: number): DmsParts {
  const scale = 10 ** SECOND_DIGITS;
  const total = Math.round(Math.abs(absDeg) * 3600 * scale);
  const sec = (total % (60 * scale)) / scale;
  const totalMin = Math.floor(total / (60 * scale));
  return { deg: Math.floor(totalMin / 60), min: totalMin % 60, sec };
}

function hemisphere(value: number, positive: string, negative: string): string {
  return value < 0 ? negative : positive;
}

function formatDecimalAxis(value: number, positive: string, negative: string): string {
  return `${Math.abs(value).toFixed(DECIMAL_DIGITS)}°${hemisphere(value, positive, negative)}`;
}

function formatDmsAxis(value: number, positive: string, negative: string): string {
  const { deg, min, sec } = splitDms(value);
  const minText = String(min).padStart(2, "0");
  const secText = sec.toFixed(SECOND_DIGITS).padStart(5, "0");
  return `${deg}°${minText}′${secText}″${hemisphere(value, positive, negative)}`;
}

export function formatLonLat(lon: number, lat: number, format: LonLatFormat): string {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return "";
  if (format === "dms") return `${formatDmsAxis(lon, "E", "W")}  ${formatDmsAxis(lat, "N", "S")}`;
  return `${formatDecimalAxis(lon, "E", "W")}  ${formatDecimalAxis(lat, "N", "S")}`;
}
