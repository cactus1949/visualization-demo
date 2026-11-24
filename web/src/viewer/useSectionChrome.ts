/**
 * 剖面悬浮窗的开关、折叠、位置约束与拖拽状态管理。
 */
import { ref, type Ref } from "vue";
import type { SectionKind } from "../render/sections/types";
import { clampFloatBox } from "../state/floatFrame";
import { reduceSectionChrome } from "../state/sectionChrome";

export interface SectionChromeDeps {
  stageEl: Ref<HTMLDivElement | null>;
  section: { enabled: boolean; kind: SectionKind };
  selectKind: (kind: SectionKind) => void;
}

export function useSectionChrome(deps: SectionChromeDeps) {
  const sectionFloatOpen = ref(false);
  const sectionFloatCollapsed = ref(false);
  const sectionFloatPos = ref<{ x: number; y: number } | null>(null);

  function onSectionMain(): void {
    const next = reduceSectionChrome(
      {
        enabled: deps.section.enabled,
        floatOpen: sectionFloatOpen.value,
        collapsed: sectionFloatCollapsed.value,
        kind: deps.section.kind,
      },
      "main",
    );
    if (next.enabled && !deps.section.enabled) {
      deps.selectKind("lon");
      sectionFloatOpen.value = true;
      sectionFloatCollapsed.value = false;
      return;
    }
    sectionFloatOpen.value = next.floatOpen;
    if (!next.enabled) deps.section.enabled = false;
  }

  function onSectionSettings(): void {
    const next = reduceSectionChrome(
      {
        enabled: deps.section.enabled,
        floatOpen: sectionFloatOpen.value,
        collapsed: sectionFloatCollapsed.value,
        kind: deps.section.kind,
      },
      "settings",
    );
    sectionFloatOpen.value = next.floatOpen;
    sectionFloatCollapsed.value = next.collapsed;
  }

  function onSectionFloatClose(): void {
    sectionFloatOpen.value = reduceSectionChrome(
      {
        enabled: deps.section.enabled,
        floatOpen: sectionFloatOpen.value,
        collapsed: sectionFloatCollapsed.value,
        kind: deps.section.kind,
      },
      "close",
    ).floatOpen;
  }

  function onSectionFloatCollapse(): void {
    const action = sectionFloatCollapsed.value ? "expand" : "collapse";
    sectionFloatCollapsed.value = reduceSectionChrome(
      {
        enabled: deps.section.enabled,
        floatOpen: sectionFloatOpen.value,
        collapsed: sectionFloatCollapsed.value,
        kind: deps.section.kind,
      },
      action,
    ).collapsed;
  }

  function clampSectionFloat(): void {
    const stage = deps.stageEl.value;
    const frame = stage?.querySelector(".section-float") as HTMLElement | null;
    if (!stage || !frame || !sectionFloatPos.value) return;
    sectionFloatPos.value = clampFloatBox(
      { ...sectionFloatPos.value, width: frame.offsetWidth, height: frame.offsetHeight },
      { width: stage.clientWidth, height: stage.clientHeight },
    );
  }

  function onSectionFloatDrag(event: PointerEvent): void {
    if ((event.target as HTMLElement).closest("button, input, select, label, a")) return;
    const stage = deps.stageEl.value;
    const frame = (event.currentTarget as HTMLElement).parentElement;
    if (!stage || !frame) return;
    const stageRect = stage.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const origin = sectionFloatPos.value ?? { x: frameRect.left - stageRect.left, y: frameRect.top - stageRect.top };
    sectionFloatPos.value = origin;
    const startX = event.clientX;
    const startY = event.clientY;
    frame.setPointerCapture(event.pointerId);
    const move = (ev: PointerEvent) => {
      sectionFloatPos.value = clampFloatBox(
        {
          x: origin.x + ev.clientX - startX,
          y: origin.y + ev.clientY - startY,
          width: frameRect.width,
          height: frameRect.height,
        },
        { width: stage.clientWidth, height: stage.clientHeight },
      );
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return {
    sectionFloatOpen,
    sectionFloatCollapsed,
    sectionFloatPos,
    onSectionMain,
    onSectionSettings,
    onSectionFloatClose,
    onSectionFloatCollapse,
    clampSectionFloat,
    onSectionFloatDrag,
  };
}
