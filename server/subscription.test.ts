import assert from "node:assert/strict";
import test from "node:test";
import { extractSubscriptionVodSources } from "./subscription";

test("解析标准 vod 数组中的视频资源站", () => {
  const sources = extractSubscriptionVodSources({
    vod: [
      { name: "标准资源站", api: "https://example.com/api.php/provide/vod", type: 0 },
      { name: "非视频数据", api: "https://example.com/api.php/provide/other", type: 1 }
    ]
  });

  assert.deepEqual(sources, [{ name: "标准资源站", api: "https://example.com/api.php/provide/vod", type: 0 }]);
});

test("解析以域名为键且省略 type 的资源站映射", () => {
  const source = {
    name: "360资源",
    api: "https://360zyzz.com/api.php/provide/vod",
    detail: "https://360zy.com"
  };

  assert.deepEqual(
    extractSubscriptionVodSources({
      "360zy.com": source,
      "other.example": { name: "非视频数据", api: "https://example.com/other", type: 1 },
      metadata: { version: 1 }
    }),
    [source]
  );
});

test("标准数组缺少 type 时不导入", () => {
  assert.deepEqual(extractSubscriptionVodSources([{ name: "未知类型", api: "https://example.com/api.php/provide/vod" }]), []);
});
