/**
 * 剖面工具条的状态。主按钮在开时负责关掉剖面；设置按钮只打开配置。
 * 关掉或收起浮窗都不改「剖面是否在画」。
 */

export interface SectionChrome {
  enabled: boolean;
  floatOpen: boolean;
  collapsed: boolean;
  kind: string;
}

export type SectionChromeAction = "main" | "settings" | "close" | "collapse" | "expand";

export function reduceSectionChrome(state: SectionChrome, action: SectionChromeAction): SectionChrome {
  if (action === "main") {
    if (state.enabled) return { ...state, enabled: false, floatOpen: false };
    return { ...state, enabled: true, floatOpen: true, collapsed: false, kind: "lon" };
  }
  if (action === "settings") return { ...state, floatOpen: true, collapsed: false };
  if (action === "close") return { ...state, floatOpen: false };
  if (action === "collapse") return { ...state, collapsed: true };
  return { ...state, collapsed: false };
}

/** 剖面被关掉（包括体渲染互斥）时，配置浮窗一起收起。 */
export function sectionChromeWhenEnabled(state: SectionChrome, enabled: boolean): SectionChrome {
  if (enabled) return { ...state, enabled: true };
  return { ...state, enabled: false, floatOpen: false };
}
