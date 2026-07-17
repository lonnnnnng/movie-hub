import path from "node:path";

export const mediaDir = path.resolve("media");
export const hlsDir = path.join(mediaDir, ".hls");
export const legacyHlsDir = path.resolve("server", "data", "hls");
