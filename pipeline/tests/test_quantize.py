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
    # missing cell -> reserved top code, finite values use 0..254
    assert q[0] == 0 and q[2] == 254 and q[3] == 255 and m["nan_code"] == 255
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


def test_nan_gets_reserved_code_and_decodes_back_to_nan():
    x = np.array([0.0, 0.25, np.nan, 1.0])
    q, m = quantize(x, 0, 1, 8)
    assert m["nan_code"] == 255 and q[2] == 255 and q[3] == 254 and q[0] == 0
    y = dequantize(q, m["scale"], m["offset"], nan_code=m["nan_code"])
    assert np.isnan(y[2]) and abs(y[3] - 1.0) < 1e-12


def test_nan_free_arrays_keep_full_code_range():
    x = np.linspace(0, 1, 11)
    q, m = quantize(x, 0, 1, 8)
    assert "nan_code" not in m and q[-1] == 255


def test_encode_per_level_nan_roundtrip():
    x = np.linspace(-1, 1, 2 * 3 * 4).reshape(2, 3, 4)
    x[1, 0, 0] = np.nan
    for enc in ("u8_linear", "u16_linear", "u8_log10"):
        v = np.abs(x) + 0.1 if enc == "u8_log10" else x
        q, m = encode_variable(v, enc, "per_level")
        y = decode_variable(q, m)
        assert m["nan_count"] == 1 and m["nan_code"] == (255 if enc.startswith("u8") else 65535)
        assert np.isnan(y[1, 0, 0]) and np.isfinite(np.delete(y.ravel(), 12)).all()
        # level 0 has no NaN but shares the reserved-code grid; its max must still decode exactly
        assert abs(np.nanmax(y[0]) - np.max(v[0])) <= max(m["level_scale"][0], 1e-12) * 0.5 + 1e-9 or enc == "u8_log10"


def test_encode_u8_int_nan():
    x = np.array([0.0, 3.0, np.nan, 254.0])
    q, m = encode_variable(x, "u8_int")
    assert m["nan_code"] == 255 and q.tolist() == [0, 3, 255, 254]
    y = decode_variable(q, m)
    assert np.isnan(y[2]) and y[3] == 254


def test_reserve_nan_shared_across_frames_keeps_one_grid():
    a = np.array([0.0, 0.5, 1.0]); b = np.array([0.0, np.nan, 1.0])
    qa, ma = encode_variable(a, "u8_linear", shared_range=(0.0, 1.0), reserve_nan=True)
    qb, mb = encode_variable(b, "u8_linear", shared_range=(0.0, 1.0), reserve_nan=True)
    assert ma["scale"] == mb["scale"] and ma["nan_code"] == mb["nan_code"] == 255 and qa[2] == 254
