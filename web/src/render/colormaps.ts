import * as THREE from "three";

const STOPS: Record<string, string[]> = {
  viridis: ["#440154", "#31688e", "#35b779", "#fde725"],
  magma: ["#000004", "#721f81", "#f1605d", "#fcfdbf"],
  turbo: ["#30123b", "#2c7bb6", "#abd9e9", "#ffffbf", "#d7191c"],
  blues: ["#f7fbff", "#6baed6", "#08306b"],
  rdbu: ["#2166ac", "#f7f7f7", "#b2182b"],
  coolwarm: ["#3b4cc0", "#dddcdc", "#b40426"],
};

export function colorMap(name: string, value: number): THREE.Color {
  const stops = STOPS[name] ?? STOPS.viridis;
  const position = THREE.MathUtils.clamp(value, 0, 1) * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(position));
  return new THREE.Color(stops[index]).lerp(new THREE.Color(stops[index + 1]), position - index);
}

export function colorTexture(name: string): THREE.DataTexture {
  const bytes = new Uint8Array(256 * 4);
  for (let index = 0; index < 256; index += 1) {
    const color = colorMap(name, index / 255);
    bytes[index * 4] = Math.round(color.r * 255);
    bytes[index * 4 + 1] = Math.round(color.g * 255);
    bytes[index * 4 + 2] = Math.round(color.b * 255);
    bytes[index * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(bytes, 256, 1, THREE.RGBAFormat);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
