export const ANNOTATION_TOKENS = Object.freeze({
  colors: Object.freeze({
    preview: "#5CE1FF",
    hover: "#5CE1FF",
    fixed: "#FFC247",
    active: "#FFC247",
    selectedOutline: "#FFFFFF",
    disabled: "#8A97A3",
    labelText: "#F4FBFF",
    labelBackground: "rgba(8, 14, 22, 0.60)",
    labelBorder: "rgba(255, 255, 255, 0.18)",
    stem: "rgba(244, 251, 255, 0.70)",
    focus: "#FFFFFF",
  }),
  sizes: Object.freeze({
    markerPx: 8,
    handlePx: 11,
    hitTargetPx: 20,
    stemWidthPx: 1.5,
    ringDiameterPx: 12,
    ringStrokePx: 1.5,
    labelFontPx: 11,
    labelPadYPx: 2,
    labelPadXPx: 6,
    labelBorderPx: 1,
    labelRadiusPx: 999,
    selectedOutlinePx: 2,
    leaderPx: 12,
    hoverScale: 1.15,
    draggingScale: 1.25,
  }),
  opacity: Object.freeze({
    idle: 1,
    preview: 0.85,
    occluded: 0.35,
    disabled: 0.4,
    labelBg: 0.6,
  }),
  type: Object.freeze({
    fontFamily: 'Inter, ui-sans-serif, system-ui, "Noto Sans SC", sans-serif',
    fontVariantNumeric: "tabular-nums",
    fontWeight: 500,
    lineHeight: 1.2,
  }),
} as const);

export type AnnotationState = "idle" | "hover" | "active" | "dragging" | "disabled" | "selected";
export type AnnotationKind = "marker" | "label" | "handle";
export type AnnotationRole = "preview" | "fixed" | "neutral";

export type AnnotationTokens = typeof ANNOTATION_TOKENS;
