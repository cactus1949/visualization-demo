/**
 * Current encoding: f16 / u8 / u16 (+ log10, log1p, signed_sqrt), Brotli via HTTP
 * Content-Encoding. Delete this file (and current/) to drop the format (see services/README.md).
 */
import { count, fetchBytes, type Codec } from "./types";
import { decodeCurrent } from "./current/decode";

const codec: Codec = {
  id: "current",
  encodings: ["f16", "u8_linear", "u8_log10", "u8_int", "u8_signed_sqrt", "u16_linear", "u16_log10", "u16_signed_sqrt", "u8_log1p", "u16_log1p"],
  async load(base, meta, _name, signal) {
    return { bytes: await fetchBytes(base + meta.file, signal) };
  },
  decode({ bytes }, meta) {
    return decodeCurrent(bytes, meta);
  },
  half({ bytes }, meta) {
    return meta.dtype === "float16" ? new Uint16Array(bytes.slice(0, count(meta) * 2)) : null;
  },
};

export default codec;
