import type { AnnotationLayer } from "./annotations";

const PREVIEW = "probe-preview";
const FIXED = "probe-fixed";

/** Probe markers: a thin stem and ground ring, styled by the shared annotation layer. */
export class ProbeMarker {
  constructor(
    private readonly layer: AnnotationLayer,
    private readonly top: number,
  ) {}

  setPreview(x: number, z: number, visible = true): void {
    this.layer.addMarker(PREVIEW, {
      anchor: { x, y: 0, z },
      stemTo: { x, y: this.top, z },
      ring: true,
      role: "preview",
      visible,
    });
  }

  setPreviewVisible(visible: boolean): void {
    this.layer.setVisible(PREVIEW, visible);
  }

  setFixed(x: number, z: number, visible = true): void {
    this.layer.addMarker(FIXED, {
      anchor: { x, y: 0, z },
      stemTo: { x, y: this.top, z },
      ring: true,
      role: "fixed",
      visible,
    });
  }

  setVisible(preview: boolean, fixed: boolean): void {
    this.layer.setVisible(PREVIEW, preview);
    this.layer.setVisible(FIXED, fixed);
  }

  dispose(): void {
    this.layer.remove(PREVIEW);
    this.layer.remove(FIXED);
  }
}
