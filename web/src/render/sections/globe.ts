/**
 * Globe tab (④): sections keep their box-km geometry (same vertices as the first two tabs, only
 * subdivided) and are bent onto the curved shell in the vertex shader:
 *   box km -> (u, v, AGL m) -> h = terrain * g(u, v) + k * AGL -> forward polynomial (geoPlace).
 * Fragments still sample the field at the interpolated box-km position, so section values are the
 * same texels as on the box tabs. Depth uses three's logdepthbuf formula (docs/globe-geo.md).
 */
import * as THREE from "three";
import type { GeoMap } from "../../geo/mapping";
import {
  BOX_TO_UVAGL_GLSL,
  LOGDEPTH_FRAGMENT,
  LOGDEPTH_FRAGMENT_PARS,
  LOGDEPTH_VERTEX,
  LOGDEPTH_VERTEX_PARS,
  geoPlaceGlsl,
  type GeoUniforms,
} from "../../globe/geoShader";
import { domainUniforms, type Domain } from "../fields";

export interface SectionGlobe {
  map: GeoMap;
  /** shared globe uniforms: terrain / k written once reach every section */
  geo: GeoUniforms;
}

/**
 * Subdivision step on the shell (km). With terrain on, the shell follows the 300 x 300 ground grid
 * (~0.06 km cells) and triangles are flat in between, so the step matches the ground cell; with
 * terrain off, curvature sag over 0.06 km is far below a millimetre.
 */
export const GLOBE_SEGMENT_KM = 0.06;

export function segmentsFor(lengthKm: number, max = 320): number {
  return Math.max(1, Math.min(max, Math.ceil(Math.abs(lengthKm) / GLOBE_SEGMENT_KM)));
}

/** Vertex shader: `vLocal` = root-local box km (for sampling), position placed on the shell. */
export function globeSectionVertex(map: GeoMap): string {
  return /* glsl */ `
uniform mat4 uRootInverse;
uniform mat4 uRootMatrix;
uniform vec3 uDomain;
${geoPlaceGlsl(map)}
${BOX_TO_UVAGL_GLSL}
${LOGDEPTH_VERTEX_PARS}
out vec3 vLocal;
void main() {
  vec3 boxKm = (uRootInverse * modelMatrix * vec4(position, 1.0)).xyz;
  vLocal = boxKm;
  vec3 enu = geoPlace(boxToUvAgl(boxKm));
  gl_Position = projectionMatrix * viewMatrix * uRootMatrix * vec4(enu, 1.0);
${LOGDEPTH_VERTEX}
}
`;
}

/** Thin outline (LineLoop / LineSegments) placed on the shell like the section surfaces. */
export class GlobeLineMaterial extends THREE.ShaderMaterial {
  constructor(domain: Domain, globe: SectionGlobe, color: number, opacity = 0.9) {
    super({
      glslVersion: THREE.GLSL3,
      vertexShader: globeSectionVertex(globe.map),
      fragmentShader: /* glsl */ `
precision highp float;
${LOGDEPTH_FRAGMENT_PARS}
uniform vec3 uColor;
uniform float uOpacity;
in vec3 vLocal;
out vec4 outColor;
void main() {
${LOGDEPTH_FRAGMENT}
  outColor = vec4(uColor, uOpacity);
}
`,
      uniforms: {
        ...globe.geo,
        ...domainUniforms(domain),
        uRootInverse: { value: new THREE.Matrix4() },
        uRootMatrix: { value: new THREE.Matrix4() },
        uColor: { value: new THREE.Color().setHex(color, THREE.LinearSRGBColorSpace) },
        uOpacity: { value: opacity },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });
  }

  setRoot(root: THREE.Object3D): void {
    (this.uniforms.uRootMatrix.value as THREE.Matrix4).copy(root.matrixWorld);
    (this.uniforms.uRootInverse.value as THREE.Matrix4).copy(root.matrixWorld).invert();
  }
}

/**
 * ⑤ Depth-only twin of a section surface on the globe (box tabs: MeshBasicMaterial with
 * colorWrite false). Same placement as the surface (globeSectionVertex + shared geo uniforms), so it
 * follows terrain / k with no CPU rebuild; writes the same log depth. Pass the surface material's
 * uRootInverse / uRootMatrix uniform objects so setRoot on the surface reaches the twin too.
 */
export class GlobeDepthMaterial extends THREE.ShaderMaterial {
  constructor(domain: Domain, globe: SectionGlobe, root: { uRootInverse: THREE.IUniform; uRootMatrix: THREE.IUniform }) {
    super({
      glslVersion: THREE.GLSL3,
      vertexShader: globeSectionVertex(globe.map),
      fragmentShader: /* glsl */ `
precision highp float;
${LOGDEPTH_FRAGMENT_PARS}
uniform vec3 uDomain;
in vec3 vLocal;
out vec4 outColor;
void main() {
${LOGDEPTH_FRAGMENT}
  outColor = vec4(1.0);
}
`,
      uniforms: {
        ...globe.geo,
        ...domainUniforms(domain),
        uRootInverse: root.uRootInverse,
        uRootMatrix: root.uRootMatrix,
      },
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
      transparent: true,
    });
  }
}

/** Densified closed loop through `corners` (box km), `perEdge` points per edge. */
export function densifyLoop(corners: THREE.Vector3[], perEdge: number): Float32Array {
  const out = new Float32Array(corners.length * perEdge * 3);
  let o = 0;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]!, b = corners[(i + 1) % corners.length]!;
    for (let j = 0; j < perEdge; j++) {
      const t = j / perEdge;
      out[o++] = a.x + (b.x - a.x) * t;
      out[o++] = a.y + (b.y - a.y) * t;
      out[o++] = a.z + (b.z - a.z) * t;
    }
  }
  return out;
}

/**
 * Grid surface between two box-km edges: bottom edge a0 -> b0 and top edge a1 -> b1,
 * `nu` segments along the edges, `nv` across. Indexed triangles, same winding as the box quads.
 */
export function gridQuad(
  a0: THREE.Vector3, b0: THREE.Vector3, b1: THREE.Vector3, a1: THREE.Vector3,
  nu: number, nv: number,
  geometry?: THREE.BufferGeometry,
): THREE.BufferGeometry {
  const count = (nu + 1) * (nv + 1);
  const g = geometry ?? new THREE.BufferGeometry();
  let attr = g.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!attr || attr.count !== count) {
    attr = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    g.setAttribute("position", attr);
    const idx: number[] = [];
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const p = j * (nu + 1) + i, q = p + 1, r = p + nu + 2, s = p + nu + 1;
      idx.push(p, q, r, p, r, s);
    }
    g.setIndex(idx);
  }
  const pos = attr.array as Float32Array;
  const lo = new THREE.Vector3(), hi = new THREE.Vector3();
  let o = 0;
  for (let j = 0; j <= nv; j++) {
    const tv = j / nv;
    for (let i = 0; i <= nu; i++) {
      const tu = i / nu;
      lo.lerpVectors(a0, b0, tu);
      hi.lerpVectors(a1, b1, tu);
      lo.lerp(hi, tv);
      pos[o++] = lo.x; pos[o++] = lo.y; pos[o++] = lo.z;
    }
  }
  attr.needsUpdate = true;
  return g;
}
