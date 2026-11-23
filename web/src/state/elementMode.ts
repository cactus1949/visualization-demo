/**
 * 左侧一行是一个气象要素。同一显示方式只保留一个变量；再点当前项就关掉。
 * 不同方式互不影响。这里不表示剖面，剖面走单独的工具状态。
 */

export interface ModeBinding {
  on: boolean;
  variable: string;
}

export function toggleMode(current: ModeBinding, variable: string): ModeBinding {
  if (current.on && current.variable === variable) return { on: false, variable: current.variable };
  return { on: true, variable };
}

export interface ElementChoice {
  name: string;
  label: string;
}

export interface ElementRow {
  id: string;
  label: string;
  /** 地面色斑使用的变量名。没有地面形式时为 null。 */
  ground: string | null;
  /** 体渲染使用的变量名。没有体形式时为 null。 */
  volume: string | null;
  /** 只有风场这一行可以开粒子。 */
  particles: boolean;
}

/**
 * 地面列表里的 speed0 / none 并进「水平风速」行，不再单独成行。
 * 三维列表里的 speed 同样并进这一行。其余名字各占一行。
 */
export function elementRows(ground: readonly ElementChoice[], volume: readonly ElementChoice[]): ElementRow[] {
  const rows: ElementRow[] = [
    { id: "speed", label: "水平风速", ground: "speed0", volume: "speed", particles: true },
  ];
  for (const item of ground) {
    if (item.name === "none" || item.name === "speed0") continue;
    rows.push({ id: item.name, label: item.label, ground: item.name, volume: null, particles: false });
  }
  for (const item of volume) {
    if (item.name === "speed") continue;
    const found = rows.find((row) => row.id === item.name);
    if (found) found.volume = item.name;
    else rows.push({ id: item.name, label: item.label, ground: null, volume: item.name, particles: false });
  }
  return rows;
}
