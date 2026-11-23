/**
 * 地面色斑和体渲染各有一个开关、一个变量。
 * 开关只改开闭，下拉只改变量，两者互不影响。
 * 粒子固定用 u/v/w，剖面走单独的工具状态，都不在这里选。
 */

export interface LayerBinding {
  on: boolean;
  variable: string;
}

/** 翻转这一层的开关，变量保持不变。 */
export function toggleLayer(current: LayerBinding): LayerBinding {
  return { on: !current.on, variable: current.variable };
}

/** 换成另一个变量。层是否打开保持不变。 */
export function selectLayerVariable(current: LayerBinding, variable: string): LayerBinding {
  return { on: current.on, variable };
}
