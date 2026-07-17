import { existsSync } from "node:fs";
import path from "node:path";

const localToolDirs = [path.resolve("tools", "ffmpeg", "bin"), path.resolve("tools", "bin"), path.resolve("tools"), path.resolve("server", "bin")];

function candidateNames(baseName: string) {
  if (path.extname(baseName)) return [baseName];
  if (process.platform === "win32") {
    return [baseName, `${baseName}.exe`, `${baseName}.cmd`, `${baseName}.bat`];
  }
  return [baseName, `${baseName}.exe`];
}

export function resolveLocalToolPath(baseName: string) {
  for (const candidate of resolveLocalToolCandidates(baseName)) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function resolveLocalToolCandidates(baseName: string) {
  return localToolDirs.flatMap((dir) => candidateNames(baseName).map((name) => path.join(dir, name)));
}

export function resolveSiblingToolPath(referencePath: string | undefined, baseName: string) {
  const trimmed = referencePath?.trim();
  if (!trimmed) return undefined;

  const dir = path.dirname(trimmed);
  for (const name of candidateNames(baseName)) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
