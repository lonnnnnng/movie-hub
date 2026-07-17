export type SubscriptionSourceItem = {
  api?: unknown;
  name?: unknown;
  type?: unknown;
};

function isSubscriptionSourceItem(item: unknown): item is SubscriptionSourceItem {
  if (!item || typeof item !== "object") return false;
  const source = item as SubscriptionSourceItem;
  return typeof source.api === "string" && typeof source.name === "string";
}

export function extractSubscriptionVodSources(payload: unknown) {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const vod = Array.isArray(root.vod) ? root.vod : Array.isArray(payload) ? payload : undefined;

  if (vod) {
    return vod.filter((item): item is SubscriptionSourceItem => isSubscriptionSourceItem(item) && String(item.type) === "0");
  }

  // long：域名映射订阅没有 type 字段，只在这种结构下放宽限制，避免标准 uz/vod 数组混入非视频源。
  return Object.values(root).filter(
    (item): item is SubscriptionSourceItem =>
      isSubscriptionSourceItem(item) && (item.type === undefined || String(item.type) === "0")
  );
}
