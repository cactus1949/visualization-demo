/// <reference lib="webworker" />
import { dequantize, type DecodeReply, type DecodeRequest } from "./geoGrid";

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = ({ data }: MessageEvent<DecodeRequest>) => {
  try {
    const t0 = performance.now();
    const dem = dequantize(data.dem, data.demMeta);
    const ground = dequantize(data.ground, data.groundMeta);
    const reply: DecodeReply = { dem, ground, ms: performance.now() - t0 };
    scope.postMessage(reply, [dem.buffer, ground.buffer]);
  } catch (e) {
    scope.postMessage({ error: String(e) });
  }
};
