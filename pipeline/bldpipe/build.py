"""Clip 3D-GloBFP building footprints to the wind-grid bbox and emit an extruded glb.

Coordinates follow web/src/render/coords.ts: x = east (km, centred on the grid),
z = south (km, north is -z), y = real height in km (the frontend applies the
vertical exaggeration by scaling the parent group).
"""

from __future__ import annotations

import argparse
import json
import shutil
import struct
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

import mapbox_earcut as earcut
import numpy as np
import pyogrio
import shapely
from shapely.geometry import Polygon, box

SOURCE_NAME = "3D-GloBFP (Che et al., 2024, ESSD 16:5357) tile 2292 + OpenStreetMap height tags"
SOURCE_URL = "https://zenodo.org/records/15459025"
SOURCE_LICENSE = "3D-GloBFP: CC BY 4.0; OpenStreetMap: ODbL 1.0 (© OpenStreetMap contributors)"


@dataclass
class GridFrame:
    lon_min: float
    lon_max: float
    lat_min: float
    lat_max: float
    size_x_km: float
    size_z_km: float

    @classmethod
    def from_manifest(cls, manifest_path: Path) -> "GridFrame":
        grid = json.loads(manifest_path.read_text())["grid"]
        return cls(
            lon_min=grid["lon_min"],
            lon_max=grid["lon_max"],
            lat_min=grid["lat_min"],
            lat_max=grid["lat_max"],
            size_x_km=(grid["nx"] - 1) * grid["dx_m"] / 1000.0,
            size_z_km=(grid["ny"] - 1) * grid["dy_m"] / 1000.0,
        )

    def project(self, lon: np.ndarray, lat: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Linear lon/lat -> local km, identical to gridToWorld()."""
        fx = (lon - self.lon_min) / (self.lon_max - self.lon_min)
        fy = (lat - self.lat_min) / (self.lat_max - self.lat_min)
        return (fx - 0.5) * self.size_x_km, (0.5 - fy) * self.size_z_km


def read_footprints(shp: Path, frame: GridFrame) -> tuple[np.ndarray, np.ndarray]:
    bbox = (frame.lon_min, frame.lat_min, frame.lon_max, frame.lat_max)
    _, _, geometry, fields = pyogrio.raw.read(shp, bbox=bbox, columns=["Height"])
    geoms = shapely.from_wkb(geometry)
    heights = np.asarray(fields[0], dtype=np.float64)
    clipped = shapely.intersection(geoms, box(*bbox))
    keep = ~shapely.is_empty(clipped)
    return clipped[keep], heights[keep]


def to_local(poly: Polygon, frame: GridFrame) -> Polygon:
    def ring(coords) -> np.ndarray:
        xy = np.asarray(coords)[:, :2]
        x, z = frame.project(xy[:, 0], xy[:, 1])
        return np.column_stack([x, z])

    return Polygon(ring(poly.exterior.coords), [ring(r.coords) for r in poly.interiors])


def extrude(poly: Polygon, height_km: float, pos: list, idx: list, count: list) -> None:
    """Append an indexed prism (roof + walls, no floor) for one polygon in the x/z plane.

    Vertices are shared between roof and walls; the frontend uses flat shading
    (normals from screen-space derivatives), so no NORMAL attribute is stored.
    This keeps ~2 vertices per footprint corner instead of 5.
    """
    poly = shapely.geometry.polygon.orient(poly, sign=1.0)
    rings = [np.asarray(poly.exterior.coords)[:-1]]
    rings += [np.asarray(r.coords)[:-1] for r in poly.interiors]
    rings = [r for r in rings if len(r) >= 3]
    if not rings:
        return
    verts = np.concatenate(rings)
    n = len(verts)
    ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
    tri = earcut.triangulate_float64(verts, ends)
    base = count[0]
    bottom = np.column_stack([verts[:, 0], np.zeros(n), verts[:, 1]])
    top = np.column_stack([verts[:, 0], np.full(n, height_km), verts[:, 1]])
    pos.append(bottom)
    pos.append(top)
    count[0] += 2 * n
    # orient(sign=1) is CCW in (x, z); with z pointing south that is CW seen from +y,
    # so flip the winding for an upward-facing roof.
    idx.append(tri.reshape(-1, 3)[:, [0, 2, 1]] + base + n)
    start = 0
    for ring in rings:
        k = len(ring)
        a = np.arange(start, start + k)
        b = np.roll(a, -1)
        start += k
        b0, b1, t1, t0 = base + a, base + b, base + n + b, base + n + a
        idx.append(np.stack([b0, t1, b1], axis=1))
        idx.append(np.stack([b0, t0, t1], axis=1))


def write_glb(path: Path, positions: np.ndarray, indices: np.ndarray) -> None:
    positions = positions.astype(np.float32)
    indices = indices.astype(np.uint32).ravel()
    blobs = [positions.tobytes(), indices.tobytes()]
    offsets = np.cumsum([0] + [len(b) for b in blobs[:-1]]).tolist()
    gltf = {
        "asset": {"version": "2.0", "generator": "bldpipe"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "buildings"}],
        "meshes": [
            {
                "name": "buildings",
                "primitives": [{"attributes": {"POSITION": 0}, "indices": 1}],
            }
        ],
        "buffers": [{"byteLength": sum(len(b) for b in blobs)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": offsets[0], "byteLength": len(blobs[0]), "target": 34962},
            {"buffer": 0, "byteOffset": offsets[1], "byteLength": len(blobs[1]), "target": 34963},
        ],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,
                "count": len(positions),
                "type": "VEC3",
                "min": positions.min(axis=0).tolist(),
                "max": positions.max(axis=0).tolist(),
            },
            {"bufferView": 1, "componentType": 5125, "count": len(indices), "type": "SCALAR"},
        ],
    }
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    binary = b"".join(blobs)
    binary += b"\0" * (-len(binary) % 4)
    total = 12 + 8 + len(js) + 8 + len(binary)
    with path.open("wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, total))
        fh.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        fh.write(struct.pack("<II", len(binary), 0x004E4942) + binary)


def build(
    shp: Path,
    manifest: Path,
    out_dir: Path,
    simplify_m: float,
    min_area_m2: float,
    osm_pbf: Path | None = None,
) -> dict:
    t0 = time.perf_counter()
    frame = GridFrame.from_manifest(manifest)
    geoms, heights = read_footprints(shp, frame)
    n_input = len(geoms)
    osm_stats: dict = {}
    if osm_pbf is not None:
        from .osm import apply_osm_heights, read_osm_buildings

        bbox = (frame.lon_min, frame.lat_min, frame.lon_max, frame.lat_max)
        osm_geoms, osm_heights = read_osm_buildings(osm_pbf, bbox)
        heights, extra_g, extra_h, osm_stats = apply_osm_heights(
            geoms, heights, osm_geoms, osm_heights
        )
        osm_stats["osm_buildings_in_bbox"] = int(len(osm_geoms))
        extra_g = shapely.intersection(extra_g, box(*bbox))
        geoms = np.concatenate([geoms, extra_g])
        heights = np.concatenate([heights, extra_h])
    pos: list[np.ndarray] = []
    idx: list[np.ndarray] = []
    kept_heights = []
    count = [0]
    for geom, h in zip(geoms, heights):
        parts = getattr(geom, "geoms", [geom])
        for part in parts:
            if part.geom_type != "Polygon":
                continue
            local = to_local(part, frame)
            if simplify_m > 0:
                local = local.simplify(simplify_m / 1000.0, preserve_topology=True)
            if local.is_empty or local.area * 1e6 < min_area_m2:
                continue
            height_m = float(h) if np.isfinite(h) and h > 0 else 3.0
            extrude(local, height_m / 1000.0, pos, idx, count)
            kept_heights.append(height_m)
    positions = np.concatenate(pos)
    indices = np.concatenate(idx)
    out_dir.mkdir(parents=True, exist_ok=True)
    raw = out_dir / "buildings.raw.glb"
    write_glb(raw, positions, indices)
    final = out_dir / "buildings.glb"
    gltfpack = shutil.which("gltfpack") or "npx"
    cmd = [gltfpack] if gltfpack != "npx" else ["npx", "--yes", "gltfpack@1.3.0"]
    # -cc: meshopt compression; 16-bit positions (~0.3 m over 18 km), no normals.
    # Quantisation adds a dequantisation transform on the node, so the frontend must
    # scale a wrapper group in y, never the loaded mesh itself. -kn keeps node names.
    cmd += ["-i", str(raw), "-o", str(final), "-cc", "-vp", "16", "-kn"]
    subprocess.run(cmd, check=True, capture_output=True)
    raw.unlink()
    hs = np.asarray(kept_heights)
    meta = {
        "count": int(len(hs)),
        "input_features": int(n_input),
        "source": SOURCE_NAME,
        "source_url": SOURCE_URL,
        "license": SOURCE_LICENSE,
        "attribution": "Che Y. et al. (2024) 3D-GloBFP, Earth Syst. Sci. Data 16, 5357-5374",
        "max_height_m": float(hs.max()),
        "mean_height_m": round(float(hs.mean()), 2),
        "p95_height_m": round(float(np.percentile(hs, 95)), 2),
        "vertices": int(len(positions)),
        "triangles": int(len(indices)),
        "simplify_m": simplify_m,
        "min_area_m2": min_area_m2,
        "bytes": final.stat().st_size,
        "units": "x east km, z south km (grid-centred), y real height km",
        **osm_stats,
        "build_s": round(time.perf_counter() - t0, 2),
    }
    (out_dir / "buildings.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    return meta


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shp", type=Path, required=True, help="3D-GloBFP tile shapefile")
    parser.add_argument("--manifest", type=Path, default=Path("data/web/lowair_atmos/manifest.json"))
    parser.add_argument("--out", type=Path, default=Path("data/web/buildings"))
    parser.add_argument("--osm-pbf", type=Path, help="OSM extract for landmark heights")
    parser.add_argument("--simplify-m", type=float, default=1.0)
    parser.add_argument("--min-area-m2", type=float, default=15.0)
    args = parser.parse_args()
    meta = build(
        args.shp, args.manifest, args.out, args.simplify_m, args.min_area_m2, args.osm_pbf
    )
    print(json.dumps(meta, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
