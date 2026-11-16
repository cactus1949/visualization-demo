"""Extract OSM building heights (height / building:levels) inside the grid bbox."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import osmium
import shapely
from shapely import wkb

LEVEL_HEIGHT_M = 3.0


def parse_height(tags) -> float | None:
    raw = tags.get("height")
    levels = tags.get("building:levels")
    try:
        if raw:
            return float(raw.lower().replace("m", "").strip())
        if levels:
            return float(levels) * LEVEL_HEIGHT_M
    except ValueError:
        return None
    return None


def read_osm_buildings(pbf: Path, bbox: tuple[float, float, float, float]):
    """Return (geometries, heights) for OSM buildings in bbox; height NaN when untagged."""
    bounds = shapely.box(*bbox)
    factory = osmium.geom.WKBFactory()
    geoms: list = []
    heights: list[float] = []

    class Handler(osmium.SimpleHandler):
        def area(self, area):  # noqa: D401 - osmium callback
            if "building" not in area.tags:
                return
            try:
                geom = wkb.loads(factory.create_multipolygon(area), hex=True)
            except Exception:  # broken multipolygons are skipped
                return
            if not geom.intersects(bounds):
                return
            height = parse_height(area.tags)
            geoms.append(geom)
            heights.append(np.nan if height is None else height)

    Handler().apply_file(str(pbf), locations=True)
    return np.asarray(geoms, dtype=object), np.asarray(heights, dtype=np.float64)


def apply_osm_heights(geoms, heights, osm_geoms, osm_heights, min_overlap: float = 0.3):
    """Raise footprint heights to OSM tagged heights where footprints overlap.

    3D-GloBFP is a regression product and strongly underestimates landmark towers
    (its max here is ~130 m while OSM tags 300+ m). OSM tagged heights are sparse
    but exact, so they win where a GloBFP footprint overlaps a tagged OSM building
    by at least `min_overlap` of the footprint area.
    """
    tagged = np.isfinite(osm_heights)
    osm_geoms = osm_geoms[tagged]
    osm_heights = osm_heights[tagged]
    tree = shapely.STRtree(osm_geoms)
    pairs = tree.query(geoms, predicate="intersects")
    out = heights.copy()
    updated = 0
    for gi, oi in zip(*pairs):
        inter = shapely.area(shapely.intersection(geoms[gi], osm_geoms[oi]))
        area = shapely.area(geoms[gi])
        if area > 0 and inter / area >= min_overlap and osm_heights[oi] > out[gi]:
            out[gi] = osm_heights[oi]
            updated += 1
    matched = np.zeros(len(osm_geoms), dtype=bool)
    matched[np.unique(pairs[1])] = True
    extra_geoms = osm_geoms[~matched]
    extra_heights = osm_heights[~matched]
    stats = {
        "osm_tagged": int(tagged.sum()),
        "globfp_heights_raised": int(updated),
        "osm_unmatched_added": int(len(extra_geoms)),
    }
    return out, extra_geoms, extra_heights, stats
