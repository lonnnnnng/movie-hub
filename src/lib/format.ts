import type { CatalogItem, MediaKind, MediaProbeInfo, SourceRoute } from "../types";

export function imageUrlFor(url?: string) {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return `/image/fetch?url=${encodeURIComponent(url)}`;
  return url;
}

export function playerUrlFor(url: string) {
  if (/\.m3u8(\?|$)/i.test(url)) return `/stream/proxy.m3u8?url=${encodeURIComponent(url)}`;
  return `/stream/fetch?url=${encodeURIComponent(url)}`;
}

export function fileSize(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatDuration(seconds?: number) {
  if (seconds == null || Number.isNaN(seconds)) return "--";
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

export function mediaProbeSummary(probe?: MediaProbeInfo) {
  if (!probe) return "";

  const parts: string[] = [];
  if (probe.durationSeconds != null) parts.push(formatDuration(probe.durationSeconds));
  if (probe.width && probe.height) parts.push(`${probe.width}x${probe.height}`);
  const codecs = [probe.videoCodec, probe.audioCodec].filter(Boolean).join("/");
  if (codecs) parts.push(codecs);
  if (probe.bitrateKbps) parts.push(`${Math.round(probe.bitrateKbps)} kbps`);
  if (!parts.length && probe.containerFormat) parts.push(probe.containerFormat);
  return parts.join(" | ");
}

export function kindText(kind: MediaKind) {
  return {
    movie: "电影",
    series: "剧集",
    anime: "动漫",
    variety: "综艺",
    unknown: "影视"
  }[kind];
}

export function formatTime(value?: string) {
  if (!value) return "尚未检查";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function detailPath(item: CatalogItem) {
  return `/detail/${encodeURIComponent(item.sourceId)}/${encodeURIComponent(item.vodId)}`;
}

export function routeStatusText(route: SourceRoute) {
  if (route.playable) return "可播放";
  if (route.status === "disabled") return "已停用";
  if (route.status === "missing") return "未命中";
  return "探测失败";
}
