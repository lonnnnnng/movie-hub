import assert from "node:assert/strict";
import { buildFfmpegDownloadArgs, buildFfmpegHlsArgs, buildNm3u8DlReArgs } from "../server/toolArgs";

const settings = {
  sourceHealthCheckIntervalMinutes: 30,
  ffmpegPath: "C:/Tools/ffmpeg.exe",
  ffmpegHlsSegmentSeconds: 8,
  ffmpegReconnectDelaySeconds: 11,
  ffmpegDownloadInputArgs: '-rw_timeout 15000000 -user_agent "My UA"',
  ffmpegDownloadOutputArgs: "-movflags +faststart",
  ffmpegHlsInputArgs: "-hwaccel auto",
  ffmpegHlsOutputArgs: "-hls_flags independent_segments",
  m3u8DownloaderPath: "tools/N_m3u8DL-RE.exe",
  m3u8DownloaderThreads: 22,
  m3u8DownloaderRetryCount: 7,
  m3u8DownloaderTimeoutSeconds: 44,
  m3u8DownloaderHeaders: "Cookie: abc=1\nReferer: https://example.test",
  m3u8DownloaderProxy: "http://127.0.0.1:7890",
  m3u8DownloaderMaxSpeed: "15M",
  m3u8DownloaderMuxAfterDone: "format=mkv",
  m3u8DownloaderExtraArgs: '--append-url-params --select-video "res=1080"',
  shareSmbUrl: "",
  shareFtpUrl: ""
};

const nm3u8 = buildNm3u8DlReArgs(
  {
    url: "https://x.test/a.m3u8",
    titleDir: "D:/Media/Show",
    saveName: "E01",
    tempDir: "D:/Media/Show/.tmp",
    ffmpegAvailable: true
  },
  settings
);
const ffmpegDownload = buildFfmpegDownloadArgs({ url: "https://x.test/a.m3u8", outputPath: "D:/Media/Show/E01.mp4" }, settings);
const ffmpegHls = buildFfmpegHlsArgs(
  { input: "D:/Media/Show/E01.mp4", segmentPattern: "D:/HLS/seg_%05d.ts", playlist: "D:/HLS/index.m3u8" },
  settings
);

assert.deepEqual(nm3u8.slice(nm3u8.indexOf("--thread-count"), nm3u8.indexOf("--thread-count") + 2), ["--thread-count", "22"]);
assert.ok(nm3u8.includes("Cookie: abc=1"));
assert.ok(nm3u8.includes("Referer: https://example.test"));
assert.deepEqual(nm3u8.slice(nm3u8.indexOf("--custom-proxy"), nm3u8.indexOf("--custom-proxy") + 2), [
  "--custom-proxy",
  "http://127.0.0.1:7890"
]);
assert.deepEqual(nm3u8.slice(nm3u8.indexOf("--max-speed"), nm3u8.indexOf("--max-speed") + 2), ["--max-speed", "15M"]);
assert.deepEqual(nm3u8.slice(nm3u8.indexOf("-M"), nm3u8.indexOf("-M") + 2), ["-M", "format=mkv"]);
assert.deepEqual(nm3u8.slice(-3), ["--append-url-params", "--select-video", "res=1080"]);
assert.ok(!nm3u8.includes("--del-after-done"));

assert.deepEqual(ffmpegDownload.slice(ffmpegDownload.indexOf("-reconnect_delay_max"), ffmpegDownload.indexOf("-reconnect_delay_max") + 2), [
  "-reconnect_delay_max",
  "11"
]);
assert.ok(ffmpegDownload.indexOf("-rw_timeout") < ffmpegDownload.indexOf("-i"));
assert.ok(ffmpegDownload.indexOf("-movflags") > ffmpegDownload.indexOf("-i"));
assert.ok(ffmpegDownload.includes("My UA"));

assert.ok(ffmpegHls.indexOf("-hwaccel") < ffmpegHls.indexOf("-i"));
assert.deepEqual(ffmpegHls.slice(ffmpegHls.indexOf("-hls_time"), ffmpegHls.indexOf("-hls_time") + 2), ["-hls_time", "8"]);
assert.ok(ffmpegHls.indexOf("-hls_flags") > ffmpegHls.indexOf("-hls_segment_filename"));

console.log("tool args settings are wired into downloader commands");
