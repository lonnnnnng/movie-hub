import type { ToolsStatusResponse } from "../types";

export type ToolWarningContext = "general" | "download" | "settings" | "stream";

export function missingToolLabels(tools?: ToolsStatusResponse | null) {
  if (!tools) return [];
  const missing: string[] = [];
  if (!tools.ffmpeg.ok) missing.push("ffmpeg");
  if (!tools.nM3u8DlRe.ok) missing.push("N_m3u8DL-RE");
  return missing;
}

export function toolWarningText(tools?: ToolsStatusResponse | null, context: ToolWarningContext = "general") {
  const missing = missingToolLabels(tools);
  if (!missing.length) return "";

  const prefix = {
    general: "",
    download: "下载前提醒：",
    settings: "系统设置提醒：",
    stream: "推流提醒："
  }[context];

  if (missing.includes("ffmpeg") && missing.includes("N_m3u8DL-RE")) {
    return `${prefix}未检测到 ffmpeg 和 N_m3u8DL-RE，请把工具放到 tools 目录，或在系统设置里配置路径。`;
  }

  if (missing.includes("ffmpeg")) {
    return `${prefix}未检测到 ffmpeg，本地 HLS、推流和 ffmpeg 兜底下载会受影响。`;
  }

  return `${prefix}未检测到 N_m3u8DL-RE，m3u8 下载会尝试使用 ffmpeg 兜底。`;
}
