import { VerticalSection } from "../slices";
import type { Domain } from "../fields";

/** Axis aligned section wall used by the 经度/纬度 modes. */
export class AxisSection extends VerticalSection {
  constructor(domain: Domain, axis: "lon" | "lat" = "lon") {
    super(domain);
    this.azimuthDeg = axis === "lon" ? 0 : 90;
  }
  setAxis(axis: "lon" | "lat"): void { this.azimuthDeg = axis === "lon" ? 0 : 90; this.setOffset(this.offsetKm()); }
}

export { VerticalSection };
