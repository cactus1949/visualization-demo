import json
from pathlib import Path


def test_manifest_real():
    p = Path("data/web/lowair_atmos/manifest.json")
    if not p.exists():
        return
    m = json.loads(p.read_text())
    assert m["schema_version"] >= 2
    assert len(m["variables"]) == 23
    assert m["variables"]["w"]["shape"] == [40, 300, 300]
    for n, v in m["variables"].items():
        assert (p.parent / v["file"]).stat().st_size == v["bytes_compressed"]
        assert v["encoding"]
        assert v["dtype"] in {"uint8", "uint16", "float16"}
        assert v["range_scope"] in {"global", "per_level"}
        if v["range_scope"] == "per_level":
            assert len(v["level_scale"]) == v["shape"][0]
            assert len(v["level_offset"]) == v["shape"][0]
        elif v["dtype"] != "float16":
            assert "scale" in v and "offset" in v


def test_wind_is_f16():
    p = Path("data/web/lowair_atmos/manifest.json")
    if not p.exists():
        return
    m = json.loads(p.read_text())
    for name in ("u", "v", "w"):
        assert m["variables"][name]["encoding"] == "f16"
        assert m["variables"][name]["dtype"] == "float16"
