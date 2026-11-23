/**
 * 把浮窗留在可视区域内。标题栏整条都要能点到，不能只剩一条边在屏幕外。
 */

export interface FloatBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FloatView {
  width: number;
  height: number;
}

export function clampFloatBox(box: FloatBox, view: FloatView, titleHeight = 36): { x: number; y: number } {
  const width = Math.min(Math.max(1, box.width), Math.max(1, view.width));
  const maxX = Math.max(0, view.width - width);
  const maxY = Math.max(0, view.height - Math.min(titleHeight, view.height));
  return {
    x: Math.min(maxX, Math.max(0, box.x)),
    y: Math.min(maxY, Math.max(0, box.y)),
  };
}
