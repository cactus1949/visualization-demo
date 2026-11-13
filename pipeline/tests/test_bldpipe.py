import json

import numpy as np
import pytest

# building pipeline needs the geo stack; skip (not abort the whole run) where it is not installed
pytest.importorskip("shapely")
pytest.importorskip("pyogrio")
pytest.importorskip("mapbox_earcut")

from shapely.geometry import Polygon  # noqa: E402

from bldpipe.build import GridFrame, extrude, write_glb


def frame() -> GridFrame:
    return GridFrame(117.0, 117.2, 39.0, 39.2, 18.0, 18.0)


def test_project_matches_coords_ts():
    x, z = frame().project(np.array([117.0, 117.2]), np.array([39.0, 39.2]))
    assert np.allclose(x, [-9.0, 9.0])
    # lat_min is the south edge -> +z (south), lat_max -> -z (north)
    assert np.allclose(z, [9.0, -9.0])


def test_extrude_square_prism_is_closed_and_upright():
    pos, idx, count = [], [], [0]
    extrude(Polygon([(0, 0), (1, 0), (1, 1), (0, 1)]), 0.05, pos, idx, count)
    positions = np.concatenate(pos)
    triangles = np.concatenate(idx)
    assert positions.shape == (8, 3)
    assert count[0] == 8
    assert len(triangles) == 2 + 8  # roof + 4 walls x 2
    roof = [t for t in triangles if np.all(positions[t, 1] > 0)]
    a, b, c = positions[roof[0]]
    normal = np.cross(b - a, c - a)
    assert normal[1] > 0  # roof faces up


def test_extrude_walls_face_outward():
    pos, idx, count = [], [], [0]
    extrude(Polygon([(0, 0), (1, 0), (1, 1), (0, 1)]), 0.05, pos, idx, count)
    positions = np.concatenate(pos)
    centre = np.array([0.5, 0.0, 0.5])
    for tri in np.concatenate(idx):
        a, b, c = positions[tri]
        normal = np.cross(b - a, c - a)
        if abs(normal[1]) > 1e-9:
            continue
        mid = (a + b + c) / 3 - centre
        mid[1] = 0
        assert np.dot(normal, mid) > 0


def test_write_glb_header(tmp_path):
    out = tmp_path / "b.glb"
    write_glb(out, np.zeros((3, 3)), np.array([[0, 1, 2]]))
    data = out.read_bytes()
    assert data[:4] == b"glTF"
    length = int.from_bytes(data[12:16], "little")
    gltf = json.loads(data[20 : 20 + length])
    assert gltf["meshes"][0]["primitives"][0]["attributes"] == {"POSITION": 0}
