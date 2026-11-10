import numpy as np
from ncpipe.quantize import quantize, dequantize, encode_variable, decode_variable


def test_roundtrip():
    x = np.linspace(-2, 3, 101)
    q, m = quantize(x, -2, 3, 8)
    y = dequantize(q, m["scale"], m["offset"])
    assert np.max(abs(x - y)) <= m["scale"] / 2 + 1e-8
    q, m = quantize(x, -2, 3, 16)
    y = dequantize(q, m["scale"], m["offset"])
    assert np.max(abs(x - y)) <= m["scale"] / 2 + 1e-8


def test_clip_nan():
    q, m = quantize(np.array([-2.0, 0.0, 2.0, np.nan]), 0, 1, 8)
    assert q[0] == 0 and q[2] == 255 and q[3] == 0
    assert m["nan_count"] == 1
    assert m["clipped_low_frac"] > 0


def test_log10():
    x = np.array([100.0, 1000.0, 10000.0])
    q, m = quantize(x, 2, 4, 8, "log10")
    y = dequantize(q, m["scale"], m["offset"], "log10")
    assert np.max(abs(np.log10(y) - np.log10(x))) <= m["scale"] / 2 + 1e-8


def test_encode_u8_linear_global():
    x = np.linspace(-5, 5, 1000)
    q, m = encode_variable(x, "u8_linear", "global")
    y = decode_variable(q, m)
    assert m["dtype"] == "uint8" and m["range_scope"] == "global"
    assert np.max(np.abs(x - y)) <= m["scale"] / 2 + 1e-8


def test_encode_u16_linear():
    x = np.linspace(-20, 20, 2000)
    q, m = encode_variable(x, "u16_linear", "global")
    y = decode_variable(q, m)
    assert m["dtype"] == "uint16"
    assert np.max(np.abs(x - y)) <= m["scale"] / 2 + 1e-8
    assert np.max(np.abs(x - y)) < 4e-4


def test_encode_f16():
    rng = np.random.default_rng(0)
    x = rng.uniform(-20, 20, size=5000)
    q, m = encode_variable(x, "f16")
    y = decode_variable(q, m)
    assert m["dtype"] == "float16" and q.dtype == np.float16
    # IEEE-754 binary16: for |x|<=20 the ulp is 1/256, so max abs err < 0.004
    assert np.max(np.abs(x.astype(np.float32) - y)) <= 0.008


def test_encode_per_level():
    z, y, x = 4, 8, 8
    data = np.zeros((z, y, x), dtype=np.float64)
    for k in range(z):
        data[k] = np.linspace(k * 10, k * 10 + 2, y * x).reshape(y, x)
    q, m = encode_variable(data, "u8_linear", "per_level")
    rec = decode_variable(q, m)
    assert m["range_scope"] == "per_level"
    assert len(m["level_scale"]) == z
    for k in range(z):
        assert np.max(np.abs(data[k] - rec[k])) <= m["level_scale"][k] / 2 + 1e-8


def test_encode_log10_and_signed_sqrt():
    pos = np.array([1e-4, 1e-2, 0.1, 1.0, 10.0])
    q, m = encode_variable(pos, "u8_log10", "global")
    rec = decode_variable(q, m)
    log_err = np.max(np.abs(np.log10(np.maximum(rec, 1e-12)) - np.log10(pos)))
    assert m["transform"] == "log10"
    assert log_err <= m["scale"] / 2 + 1e-8

    signed = np.linspace(-9, 16, 50)
    q, m = encode_variable(signed, "u8_signed_sqrt", "global")
    rec = decode_variable(q, m)
    trans_err = np.max(np.abs(np.sign(signed) * np.sqrt(np.abs(signed)) - np.sign(rec) * np.sqrt(np.abs(rec))))
    assert m["transform"] == "signed_sqrt"
    assert trans_err <= m["scale"] / 2 + 1e-8
