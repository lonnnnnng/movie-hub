import { Camera, Gauge, Maximize, RotateCcw, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import videojs from "video.js";
import "video.js/dist/video-js.css";
import {
  END_CLEAR_SECONDS,
  MIN_RESUME_SECONDS,
  clearPlaybackProgress,
  formatDuration,
  progressStorageKey,
  readPlaybackProgress,
  savePlaybackProgress as saveStoredPlaybackProgress,
  type PlaybackProgress
} from "../lib/playerProgress";
import { useStoredState } from "../lib/storage";

type VideoPlayerProps = {
  url: string;
  title?: string;
};

type VideoJsPlayer = ReturnType<typeof videojs>;

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
const SAVE_INTERVAL_SECONDS = 5;

function formatRate(rate: number) {
  return `${Number.isInteger(rate) ? rate.toFixed(0) : rate}x`;
}

export function VideoPlayer({ url, title }: VideoPlayerProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<VideoJsPlayer | null>(null);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const rateControlRef = useRef<HTMLDivElement | null>(null);
  const progressKeyRef = useRef(progressStorageKey(url));
  const [playbackRate, setPlaybackRate] = useStoredState<number>("movie-hub.player.playbackRate", 1, { validate: isPlaybackRate });
  const [rateMenuOpen, setRateMenuOpen] = useState(false);
  const [resumeProgress, setResumeProgress] = useState<PlaybackProgress | null>(null);

  useEffect(() => {
    if (!mountRef.current) return undefined;
    const progressKey = progressStorageKey(url);
    progressKeyRef.current = progressKey;
    setResumeProgress(null);

    const videoElement = document.createElement("video-js") as unknown as HTMLVideoElement;
    videoElement.classList.add("vjs-big-play-centered", "vjs-theme-moviehub");
    videoElement.setAttribute("playsinline", "true");
    videoElement.setAttribute("crossorigin", "anonymous");
    mountRef.current.appendChild(videoElement);
    videoElementRef.current = videoElement;

    const player = videojs(videoElement, {
      controls: true,
      fluid: true,
      responsive: true,
      preload: "metadata",
      playbackRates: [...PLAYBACK_RATES],
      controlBar: {
        currentTimeDisplay: true,
        timeDivider: true,
        durationDisplay: true,
        liveDisplay: false,
        seekToLive: false,
        remainingTimeDisplay: false,
        pictureInPictureToggle: false
      },
      sources: [
        {
          src: url,
          type: url.includes("proxy.m3u8") || /\.m3u8(\?|$)/i.test(url) ? "application/x-mpegURL" : "video/mp4"
        }
      ],
      html5: {
        vhs: {
          overrideNative: true
        }
      }
    });
    let lastSavedSecond = 0;
    const handleRateChange = () => {
      setPlaybackRate(player.playbackRate() ?? 1);
    };
    const handleProgressSave = () => {
      const currentSecond = Math.floor(Number(player.currentTime() ?? 0));
      if (currentSecond - lastSavedSecond < SAVE_INTERVAL_SECONDS) return;
      lastSavedSecond = currentSecond;
      savePlayerProgress(progressKey, player, title, url);
    };
    const handleProgressSaveNow = () => {
      lastSavedSecond = Math.floor(Number(player.currentTime() ?? 0));
      savePlayerProgress(progressKey, player, title, url);
    };
    const handleEnded = () => {
      clearPlaybackProgress(progressKey);
      setResumeProgress(null);
    };
    const restoreProgress = () => {
      const progress = readPlaybackProgress(progressKey);
      const playerDuration = Number(player.duration());
      const duration = Number.isFinite(playerDuration) && playerDuration > 0 ? playerDuration : progress?.duration ?? 0;
      if (!progress || !Number.isFinite(duration) || duration <= MIN_RESUME_SECONDS) return;
      if (progress.time < MIN_RESUME_SECONDS || duration - progress.time < END_CLEAR_SECONDS) {
        clearPlaybackProgress(progressKey);
        return;
      }
      player.currentTime(Math.min(progress.time, Math.max(0, duration - END_CLEAR_SECONDS)));
      setResumeProgress({ ...progress, duration });
    };

    player.playbackRate(playbackRate);
    setRateMenuOpen(false);
    player.on("ratechange", handleRateChange);
    player.on("timeupdate", handleProgressSave);
    player.on("pause", handleProgressSaveNow);
    player.on("loadedmetadata", restoreProgress);
    player.on("ended", handleEnded);
    playerRef.current = player;

    return () => {
      handleProgressSaveNow();
      player.off("ratechange", handleRateChange);
      player.off("timeupdate", handleProgressSave);
      player.off("pause", handleProgressSaveNow);
      player.off("loadedmetadata", restoreProgress);
      player.off("ended", handleEnded);
      if (!player.isDisposed()) {
        player.dispose();
      }
      playerRef.current = null;
      videoElementRef.current = null;
    };
  }, [title, url]);

  useEffect(() => {
    if (!rateMenuOpen) return undefined;

    function handlePointerDown(event: PointerEvent) {
      if (!rateControlRef.current?.contains(event.target as Node)) {
        setRateMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setRateMenuOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [rateMenuOpen]);

  function seekBy(seconds: number) {
    const player = playerRef.current;
    if (!player) return;
    player.currentTime(Math.max(0, (player.currentTime() ?? 0) + seconds));
  }

  function startOver() {
    const player = playerRef.current;
    if (!player) return;
    player.currentTime(0);
    clearPlaybackProgress(progressKeyRef.current);
    setResumeProgress(null);
  }

  function setRate(rate: number) {
    playerRef.current?.playbackRate(rate);
    setPlaybackRate(rate);
    setRateMenuOpen(false);
  }

  async function screenshot() {
    const video = playerRef.current?.el().querySelector("video") ?? videoElementRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const link = document.createElement("a");
    link.download = `${title ?? "movie-hub"}-${Math.round(playerRef.current?.currentTime() ?? 0)}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  }

  function fullscreen() {
    const player = playerRef.current;
    if (!player) return;
    if (player.isFullscreen()) {
      player.exitFullscreen();
    } else {
      player.requestFullscreen();
    }
  }

  return (
    <div className="videojs-shell">
      <div className="videojs-mount" ref={mountRef} />
      {resumeProgress ? (
        <div className="player-resume-banner">
          <span>已续播到 {formatDuration(resumeProgress.time)}</span>
          <button type="button" onClick={startOver}>
            <RotateCcw size={14} />
            从头播放
          </button>
        </div>
      ) : null}
      <div className="player-tools" aria-label="播放器快捷控制">
        <button type="button" onClick={() => seekBy(-10)} title="快退 10 秒">
          <RotateCcw size={16} />
          10s
        </button>
        <button type="button" onClick={() => seekBy(10)} title="快进 10 秒">
          <RotateCw size={16} />
          10s
        </button>
        <div className="player-rate-control" ref={rateControlRef}>
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={rateMenuOpen}
            onClick={() => setRateMenuOpen((open) => !open)}
            title="切换播放速度"
          >
            <Gauge size={16} />
            {formatRate(playbackRate)}
          </button>
          {rateMenuOpen ? (
            <div className="player-rate-menu" role="menu" aria-label="播放速度">
              {PLAYBACK_RATES.map((rate) => (
                <button
                  key={rate}
                  type="button"
                  role="menuitemradio"
                  aria-checked={playbackRate === rate}
                  className={playbackRate === rate ? "active" : undefined}
                  onClick={() => setRate(rate)}
                >
                  {formatRate(rate)}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <button type="button" onClick={() => void screenshot()} title="截图">
          <Camera size={16} />
          截图
        </button>
        <button type="button" onClick={fullscreen} title="全屏">
          <Maximize size={16} />
          全屏
        </button>
      </div>
    </div>
  );
}

function isPlaybackRate(value: unknown): value is number {
  return typeof value === "number" && PLAYBACK_RATES.includes(value as (typeof PLAYBACK_RATES)[number]);
}

function savePlayerProgress(key: string, player: VideoJsPlayer, title?: string, source?: string) {
  const duration = Number(player.duration() ?? 0);
  const time = Number(player.currentTime() ?? 0);
  if (!Number.isFinite(duration) || !Number.isFinite(time) || duration <= MIN_RESUME_SECONDS) return;

  if (time < MIN_RESUME_SECONDS || duration - time < END_CLEAR_SECONDS) {
    clearPlaybackProgress(key);
    return;
  }
  saveStoredPlaybackProgress(key, {
    time: Math.floor(time),
    duration: Math.floor(duration),
    updatedAt: new Date().toISOString(),
    title: title?.trim() || undefined,
    source
  });
}
