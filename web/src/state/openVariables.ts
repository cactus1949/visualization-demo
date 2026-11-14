/**
 * Which variables the currently open layers need, and whether playback must
 * wait for a GPU wind pack. Frame files themselves are chosen by the codecs
 * from these names; derived fields also list the stored sources they pull.
 */

export const SPEED = "speed";

const WIND_ALIASES = new Set([SPEED, "speed0", "direction"]);
const DERIVE_KEYS = ["from", "u", "v", "sigma"] as const;

export type VariableRef = {
  encoding?: string;
  derive?: Record<string, unknown>;
  dims?: readonly string[];
};

export type LayerNeed = {
  particles: boolean;
  ground: boolean;
  groundVar: string;
  volume: boolean;
  volumeVar: string;
  section: boolean;
  sectionVar: string;
  probe: boolean;
  probeVar: string;
};

export type OpenPlan = {
  /** Variables whose encoded bytes (or derived sources) should be fetched. */
  names: string[];
  /** Float32 copies the CPU readers need at frames a / b. */
  cpuNames: string[];
  /** 3D stored fields that occupy a GPU scalar slot. */
  gpuScalars: string[];
  /** Particle trails need the GPU wind pack, including w. */
  needWind: boolean;
  /** Volume or section is showing derived horizontal speed. */
  needSpeed: boolean;
  /** Queue a wind pack job (particles, or speed blended from wind slots). */
  queueWind: boolean;
  /** Wind pack should include the vertical component. */
  includeW: boolean;
};

export type FramePresence = {
  wind: (frame: number) => boolean;
  scalar: (name: string, frame: number) => boolean;
  cpu: (name: string, frame: number) => boolean;
};

function unique(names: string[]): string[] {
  return [...new Set(names)];
}

function fieldSources(name: string, vars: Record<string, VariableRef>, seen: Set<string>): string[] {
  if (WIND_ALIASES.has(name)) {
    return unique([...fieldSources("u", vars, seen), ...fieldSources("v", vars, seen)]);
  }
  const meta = vars[name];
  if (!meta || seen.has(name)) return [];
  seen.add(name);
  if (meta.encoding === "derived" && meta.derive) {
    const out = [name];
    for (const key of DERIVE_KEYS) {
      const dep = meta.derive[key];
      if (typeof dep === "string") out.push(...fieldSources(dep, vars, seen));
    }
    return unique(out);
  }
  return [name];
}

/** `name` plus any stored or intermediate sources a derived field will pull. */
export function sourcesOf(name: string, vars: Record<string, VariableRef>): string[] {
  return fieldSources(name, vars, new Set());
}

function isGpuScalar(name: string, vars: Record<string, VariableRef>): boolean {
  return name !== SPEED && (vars[name]?.dims?.length ?? 0) === 3;
}

function addCpu(cpu: string[], name: string, vars: Record<string, VariableRef>): void {
  if (WIND_ALIASES.has(name)) {
    if (vars.u) cpu.push("u");
    if (vars.v) cpu.push("v");
    return;
  }
  if (vars[name]) cpu.push(name);
}

export function planOf(layers: LayerNeed, vars: Record<string, VariableRef>): OpenPlan {
  const requested: string[] = [];
  const cpu: string[] = [];
  const gpuScalars: string[] = [];

  if (layers.particles) requested.push("u", "v", "w");

  if (layers.ground && layers.groundVar !== "none") {
    requested.push(layers.groundVar);
    addCpu(cpu, layers.groundVar, vars);
  }
  if (layers.volume) {
    requested.push(layers.volumeVar);
    addCpu(cpu, layers.volumeVar, vars);
    if (isGpuScalar(layers.volumeVar, vars)) gpuScalars.push(layers.volumeVar);
  }
  if (layers.section) {
    requested.push(layers.sectionVar);
    addCpu(cpu, layers.sectionVar, vars);
    if (isGpuScalar(layers.sectionVar, vars)) gpuScalars.push(layers.sectionVar);
  }
  if (layers.probe) {
    requested.push(SPEED);
    addCpu(cpu, SPEED, vars);
    if (!WIND_ALIASES.has(layers.probeVar)) {
      requested.push(layers.probeVar);
      addCpu(cpu, layers.probeVar, vars);
    }
  }

  const needWind = layers.particles;
  const needSpeed =
    (layers.volume && layers.volumeVar === SPEED) || (layers.section && layers.sectionVar === SPEED);
  const names = unique(requested.flatMap((name) => sourcesOf(name, vars))).filter((name) => vars[name]);

  return {
    names: names.sort(),
    cpuNames: unique(cpu).filter((name) => vars[name]).sort(),
    gpuScalars: unique(gpuScalars),
    needWind,
    needSpeed,
    queueWind: needWind || needSpeed,
    includeW: needWind,
  };
}

/** True when every resource the open layers need is present at frames a and b. */
export function canShowFrames(a: number, b: number, plan: OpenPlan, has: FramePresence): boolean {
  const frames = a === b ? [a] : [a, b];
  if (plan.queueWind && frames.some((frame) => !has.wind(frame))) return false;
  for (const name of plan.gpuScalars) {
    if (frames.some((frame) => !has.scalar(name, frame))) return false;
  }
  for (const name of plan.cpuNames) {
    if (frames.some((frame) => !has.cpu(name, frame))) return false;
  }
  return true;
}
