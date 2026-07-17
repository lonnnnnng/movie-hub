import type { AppSettings } from "./types";
import { getFfmpegPath } from "./ffmpeg";
import { linesToArgs, parseCommandArgs } from "./commandArgs";

type Nm3u8DlReArgInput = {
  url: string;
  titleDir: string;
  saveName: string;
  tempDir: string;
  ffmpegAvailable: boolean;
};

type FfmpegDownloadArgInput = {
  url: string;
  outputPath: string;
};

type FfmpegHlsArgInput = {
  input: string;
  segmentPattern: string;
  playlist: string;
};

function normalizeThreads(settings: AppSettings) {
  return Math.max(1, Math.min(64, Math.floor(settings.m3u8DownloaderThreads || 16)));
}

function normalizeRetryCount(settings: AppSettings) {
  return Math.max(1, Math.min(20, Math.floor(settings.m3u8DownloaderRetryCount || 6)));
}

function normalizeTimeoutSeconds(settings: AppSettings) {
  return Math.max(5, Math.min(120, Math.floor(settings.m3u8DownloaderTimeoutSeconds || 30)));
}

export function buildNm3u8DlReArgs(input: Nm3u8DlReArgInput, settings: AppSettings) {
  const args = [
    input.url,
    "--save-dir",
    input.titleDir,
    "--save-name",
    input.saveName,
    "--tmp-dir",
    input.tempDir,
    "--thread-count",
    String(normalizeThreads(settings)),
    "--download-retry-count",
    String(normalizeRetryCount(settings)),
    "--http-request-timeout",
    String(normalizeTimeoutSeconds(settings)),
    "--auto-select",
    "--no-log",
    "--no-ansi-color",
    "--disable-update-check"
  ];

  const headers = linesToArgs(settings.m3u8DownloaderHeaders);
  if (headers.length) {
    for (const header of headers) args.push("-H", header);
  } else {
    args.push("-H", "User-Agent: MovieHub/0.1");
  }

  if (settings.m3u8DownloaderProxy?.trim()) args.push("--custom-proxy", settings.m3u8DownloaderProxy.trim());
  if (settings.m3u8DownloaderMaxSpeed?.trim()) args.push("--max-speed", settings.m3u8DownloaderMaxSpeed.trim());

  if (input.ffmpegAvailable) {
    args.push(
      "--ffmpeg-binary-path",
      getFfmpegPath(settings.ffmpegPath),
      "-M",
      settings.m3u8DownloaderMuxAfterDone?.trim() || "format=mp4"
    );
  } else {
    args.push("--binary-merge");
  }

  args.push(...parseCommandArgs(settings.m3u8DownloaderExtraArgs));
  return args;
}

export function buildFfmpegDownloadArgs(input: FfmpegDownloadArgInput, settings: AppSettings) {
  return [
    "-y",
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    String(Math.max(1, Math.min(60, Math.floor(settings.ffmpegReconnectDelaySeconds || 5)))),
    "-headers",
    "User-Agent: MovieHub/0.1\r\n",
    ...parseCommandArgs(settings.ffmpegDownloadInputArgs),
    "-i",
    input.url,
    "-c",
    "copy",
    "-bsf:a",
    "aac_adtstoasc",
    ...parseCommandArgs(settings.ffmpegDownloadOutputArgs),
    input.outputPath
  ];
}

export function buildFfmpegHlsArgs(input: FfmpegHlsArgInput, settings: AppSettings) {
  return [
    "-y",
    ...parseCommandArgs(settings.ffmpegHlsInputArgs),
    "-i",
    input.input,
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-hls_time",
    String(Math.max(2, Math.min(30, Math.floor(settings.ffmpegHlsSegmentSeconds || 6)))),
    "-hls_playlist_type",
    "vod",
    "-hls_segment_filename",
    input.segmentPattern,
    ...parseCommandArgs(settings.ffmpegHlsOutputArgs),
    input.playlist
  ];
}
