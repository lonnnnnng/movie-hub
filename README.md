# Movie Hub

Movie Hub 是一个面向家庭影音场景的本地电影聚合平台，前端负责海报墙、搜索、详情页、追剧、片库和设置等体验，后端负责资源站聚合、资源解析、下载、HLS 生成、本地媒体代理、健康检查和运行态持久化。

## 项目概览

- 首页提供海报墙和资源站搜索入口
- 资源站搜索会并行检索全部资源站，结果以卡片流式追加展示
- 剧集详情页包含播放器、线路评估、分级播放和选集
- 资源站管理支持增删改查、搜索、分页和连通性检测
- 追剧与下载页面支持多任务并行展示和进度跟踪
- 本地片库支持扫描、搜索、分页和 HLS 生成
- 设置页可配置 ffmpeg 和 N_m3u8DL-RE 的参数
- 支持局域网访问、共享中心、通知中心和健康检查

## 技术栈

- React 19
- Vite
- TypeScript
- Express 5
- Zod
- Video.js
- lucide-react
- fast-xml-parser
- SQLite 本地数据库（通过 better-sqlite3 驱动访问）

## 主要能力

### 前端页面

- `首页`：海报墙、搜索框、热点内容、快捷入口
- `资源站搜索`：输入关键词后对所有资源站并行检索
- `剧集详情`：播放器、线路评估、分级播放、推荐依据、选集
- `资源站管理`：分页列表、搜索、弹框新增/编辑/查看、手动检测、定时检测
- `本地片库`：本地视频扫描、搜索、分页、HLS 生成、可视化进度
- `追剧/下载`：追剧列表、下载队列、任务状态、批量任务展示
- `共享中心`：局域网访问与共享信息
- `系统设置`：资源站健康检测间隔、ffmpeg 参数、N_m3u8DL-RE 参数

### 后端能力

- 聚合多个 MacCMS 类资源站
- 解析列表、详情和播放线路
- 资源站连通性检测和定时巡检
- 豆瓣热门数据补全海报、评分、简介等信息
- m3u8/mp4 代理播放
- 本地视频扫描和 Range 流式播放
- 本地 HLS 生成
- 下载任务队列和追剧更新
- 只读 FTP 共享
- 运行态数据持久化

## 目录说明

```text
src/                React 前端
src/pages/          各业务页面
src/components/     通用组件
src/lib/            前端 API 封装与格式化工具
server/             Express API、解析、下载、存储、共享逻辑
scripts/            维护脚本和跨平台服务控制脚本
tools/              内置工具
media/              本地视频目录
server/data/        运行时数据、SQLite 数据库文件
media/.hls/         HLS 切片、m3u8 播放列表和下载缓存
dist/               前端构建产物
```

## 运行环境

- Node.js 20.19+ 或 22.12+，推荐使用当前 LTS 或更新版本。
- npm 10+
- Windows 10/11、macOS、Linux 均可运行

项目的运行态数据存储在本地 SQLite 文件 `server/data/movie-hub.sqlite` 中；服务端通过 `better-sqlite3` 这个 Node.js SQLite 驱动读写数据库。`better-sqlite3` 不是独立数据库，只是访问 SQLite 的本地依赖。`node_modules` 里包含和系统架构相关的 native binding，三端部署时不要从其他系统直接复制 `node_modules`，请在目标机器上执行 `npm install`。

默认端口：
- Web：`http://localhost:5173`
- API：`http://localhost:8787`

如需改端口，可通过环境变量 `WEB_PORT` 和 `PORT` 调整。服务脚本、Vite 代理和后端 API 都会读取这两个变量。

生产部署时可以只运行 Express 后端；它会同时提供 `dist/` 前端、API、视频和 HLS 路由。例如把 API 和主访问地址设为 `4444`：

```bash
PORT=4444 node_modules/.bin/tsx server/index.ts
```

### Emby 同步

设置页的 Emby 配置会把已完成下载导出为 `tvshow.nfo`、分集 `.nfo` 和 `.strm`。将 Emby 剧集库指向 `embyOutputDir`，并填写 Emby Server URL、API Key 以及 Emby 可访问的 Movie Hub 地址；下载完成后会自动写入并请求 `/Library/Refresh`。已有下载可以在设置页点击“立即同步已有下载”。

## 安装与启动

```bash
npm install
npm run dev
```

`npm run dev` 会同时启动后端 API 和前端开发服务。

如果只想启动后端：

```bash
npm run start
```

## 跨平台服务脚本

这套脚本用于统一管理开发服务，支持启动、停止、重启、查看状态、查看日志。脚本会自动检查 `node_modules` 中的关键运行依赖，缺失时先执行 `npm install`。

## 三端一键部署脚本

部署脚本会从 Git 仓库克隆或更新代码，下载并解压 ffmpeg / ffprobe / N_m3u8DL-RE 到 `tools/`，安装依赖，创建 `media/`、`server/data/`、`var/` 运行目录，执行 `npm run verify`，重启服务，并等待 Web/API 可访问。

默认仓库是 `https://github.com/lonnnnnng/movie-hub.git`，默认分支是 `main`。

### Windows

CMD：
```cmd
scripts\deploy.cmd --dir C:\movie-hub
```

PowerShell：
```powershell
.\scripts\deploy.ps1 --dir C:\movie-hub
```

### macOS / Linux

```bash
bash scripts/deploy.sh --dir ~/movie-hub
```

也可以添加执行权限后直接运行：
```bash
chmod +x scripts/deploy.sh
./scripts/deploy.sh --dir ~/movie-hub
```

### 从空目录开始部署

如果当前机器还没有项目代码，可以先只下载部署脚本，或在任意已有目录中执行：

```bash
node scripts/deploy.mjs --repo https://github.com/lonnnnnng/movie-hub.git --branch main --dir ./movie-hub
```

部署完成后访问：
- Web：`http://localhost:5173`
- API：`http://localhost:8787`

### 常用部署参数

```bash
node scripts/deploy.mjs --dir ./movie-hub --repo https://github.com/lonnnnnng/movie-hub.git --branch main
node scripts/deploy.mjs --dir ./movie-hub --port 8887 --web-port 5180
node scripts/deploy.mjs --dir ./movie-hub --skip-pull
node scripts/deploy.mjs --dir ./movie-hub --skip-tools
node scripts/deploy.mjs --dir ./movie-hub --skip-verify
```

也可以用环境变量：

Windows CMD：
```cmd
set MOVIE_HUB_DIR=C:\movie-hub
set PORT=8887
set WEB_PORT=5180
scripts\deploy.cmd
```

PowerShell：
```powershell
$env:MOVIE_HUB_DIR = "C:\movie-hub"
$env:PORT = "8887"
$env:WEB_PORT = "5180"
.\scripts\deploy.ps1
```

macOS / Linux：
```bash
MOVIE_HUB_DIR=~/movie-hub PORT=8887 WEB_PORT=5180 bash scripts/deploy.sh
```

如果目标目录已经有未提交改动，部署脚本会停止，避免覆盖本地修改。确认要直接使用当前目录时，可以加 `--skip-pull`。

`tools/` 不进入 Git 管理。部署脚本会在工具缺失时自动下载当前系统对应的 ffmpeg / ffprobe / N_m3u8DL-RE 并解压到 `tools/`；如果你想使用自己准备的工具包，可以先放入 `tools/`，或使用 `--skip-tools` 跳过自动下载。

### Windows

CMD：
```cmd
scripts\movie-hub.cmd start
scripts\movie-hub.cmd stop
scripts\movie-hub.cmd restart
scripts\movie-hub.cmd status
scripts\movie-hub.cmd logs --lines 200
scripts\movie-hub.cmd logs --follow
```

PowerShell：
```powershell
.\scripts\movie-hub.ps1 start
.\scripts\movie-hub.ps1 stop
.\scripts\movie-hub.ps1 restart
.\scripts\movie-hub.ps1 status
.\scripts\movie-hub.ps1 logs --lines 200
```

如果 PowerShell 执行策略限制脚本，可先使用 `scripts\movie-hub.cmd ...`，或按需调整本机执行策略。

### macOS / Linux

```bash
bash scripts/movie-hub.sh start
bash scripts/movie-hub.sh stop
bash scripts/movie-hub.sh restart
bash scripts/movie-hub.sh status
bash scripts/movie-hub.sh logs --lines 200
bash scripts/movie-hub.sh logs --follow
```

也可以添加执行权限后直接运行：
```bash
chmod +x scripts/movie-hub.sh
./scripts/movie-hub.sh start
```

### 自定义端口

Windows CMD：
```cmd
set PORT=8887
set WEB_PORT=5180
scripts\movie-hub.cmd restart
```

PowerShell：
```powershell
$env:PORT = "8887"
$env:WEB_PORT = "5180"
.\scripts\movie-hub.ps1 restart
```

macOS / Linux：
```bash
PORT=8887 WEB_PORT=5180 bash scripts/movie-hub.sh restart
```

### 通用方式

```bash
node scripts/service.mjs start
node scripts/service.mjs stop
node scripts/service.mjs restart
node scripts/service.mjs status
node scripts/service.mjs logs --lines 200
node scripts/service.mjs logs --follow
```

### npm 方式

```bash
npm run service:start
npm run service:stop
npm run service:restart
npm run service:status
npm run service:logs
```

> 如果在 Windows PowerShell 里遇到 `npm.ps1 cannot be loaded`，改用 `npm.cmd` 即可。

> 如果 `npm install` 在某个平台上需要本地编译 `better-sqlite3`，请先安装该平台的基础构建工具：Windows 可安装 Visual Studio Build Tools，macOS 可安装 Xcode Command Line Tools，Linux 可安装 `python3`、`make`、`g++`。

## 常用脚本

```bash
npm run check         # TypeScript 类型检查
npm run build         # 前端构建
npm run doctor        # 检查关键文件、数据库和 API 状态
npm run verify        # check + build + doctor
npm run preview       # 预览打包后的前端
npm run verify:tool-args
```

## 工具与配置

`tools/` 目录不纳入 Git 管理。三端部署脚本会自动下载当前系统对应的工具；手动部署时也可以按目标平台自行下载。系统会自动从下面这些位置查找：
- 设置页手动配置的路径
- 环境变量 `FFMPEG_PATH`、`FFPROBE_PATH`
- 环境变量 `N_M3U8DL_RE_PATH`、`N_M3U8DL_PATH`
- 仓库内 `tools/ffmpeg/bin`、`tools/bin`、`tools`、`server/bin`
- 系统 `PATH`

推荐目录结构：

Windows：
```text
tools/
  N_m3u8DL-RE.exe
  ffmpeg/bin/ffmpeg.exe
  ffmpeg/bin/ffprobe.exe
  ffmpeg/bin/ffplay.exe
```

macOS / Linux：
```text
tools/
  N_m3u8DL-RE
  ffmpeg/bin/ffmpeg
  ffmpeg/bin/ffprobe
  ffmpeg/bin/ffplay
```

macOS / Linux 解压后如果不能执行，运行：
```bash
chmod +x tools/N_m3u8DL-RE tools/ffmpeg/bin/ffmpeg tools/ffmpeg/bin/ffprobe tools/ffmpeg/bin/ffplay
```

`ffprobe` 会跟随 `ffmpegPath` 自动寻找同目录程序，也会用于本地片库扫描，展示时长、分辨率、编码、码率等媒体信息。`ffplay` 暂不接入业务流程，保留为手动播放和排障工具。

### 工具下载

如果本地还没有这些可执行文件，可以先到下面两个 release 页面下载对应平台的压缩包，再解压到仓库的 `tools/` 目录：
- [N_m3u8DL-RE releases](https://github.com/nilaoda/N_m3u8DL-RE/releases)
- [FFmpeg-Builds releases](https://github.com/BtbN/FFmpeg-Builds/releases)

这些文件体积较大，默认不纳入 Git 管理；克隆仓库后按需自行下载即可。

### ffmpeg 配置

- `ffmpegPath`
- `ffmpegReconnectDelaySeconds`
- `ffmpegDownloadInputArgs`
- `ffmpegDownloadOutputArgs`
- `ffmpegHlsSegmentSeconds`
- `ffmpegHlsInputArgs`
- `ffmpegHlsOutputArgs`

### N_m3u8DL-RE 配置

- `m3u8DownloaderPath`
- `m3u8DownloaderThreads`
- `m3u8DownloaderRetryCount`
- `m3u8DownloaderTimeoutSeconds`
- `m3u8DownloaderHeaders`
- `m3u8DownloaderProxy`
- `m3u8DownloaderMaxSpeed`
- `m3u8DownloaderMuxAfterDone`
- `m3u8DownloaderExtraArgs`

保存后，这些参数会在调用下载器时直接生效。

## 运行时数据

运行态数据会写入 `server/data/`，这个目录已加入 `.gitignore`。

常见文件包括：

- `server/data/movie-hub.sqlite`：主状态数据库，SQLite 文件
- `media/.hls/`：本地 HLS 输出、m3u8 下载缓存和复用播放列表
- `server/data/store.json`：旧格式兼容数据，迁移时可能出现

本地视频目录是：

- `media/`

示例结构：

```text
media/
  剧名/
    第1集.mp4
```

## 常用接口概览

后端接口主要分为这些类别：

- 状态与统计：`/api/state`、`/api/stats`
- 搜索与详情：`/api/search`、`/api/detail/:siteId/:vodId`
- 资源站管理：`/api/sites/*`
- 追剧与下载：`/api/watchlist`、`/api/downloads`
- 本地片库：`/api/library`
- 共享中心：`/api/share`
- 工具状态：`/api/tools/status`

## 三端部署检查清单

1. 安装 Node.js 20.19+ 或 22.12+ 和 npm。
2. 克隆仓库后执行 `npm install`。
3. 运行三端部署脚本自动准备 ffmpeg / ffprobe / N_m3u8DL-RE；手动部署时可自行放入 `tools/` 或加入系统 `PATH`。
4. 执行 `npm run verify`，确认类型检查、构建和 doctor 通过。
5. 使用对应平台脚本启动服务。
6. 局域网访问时放行 Web 端口和 API 端口，默认是 5173 和 8787。

运行态目录不进入 Git：`server/data/`、`media/`、`tools/`、`var/`、`dist/`、`node_modules/`。

HLS 说明：新生成的 m3u8 和 ts 切片会写入 `media/.hls/`，不再写入 `server/data/hls/`。历史 `server/data/hls/` 内容仍可兼容访问，片库扫描时会尽量迁移到新目录。使用 N_m3u8DL-RE 下载 m3u8 时，系统会尽量保留下载过程中的 m3u8/ts 缓存，并生成可复用的本地 HLS 播放入口。

## 备注

- 这个项目是一个持续演进的本地影音控制台，页面和功能会跟着需求继续扩展
- 目前的重点是资源站聚合、播放体验、下载队列、本地片库和工具链可配置化
- 如果要把它跑在局域网里，直接访问机器的局域网 IP 和 `5173` / `8787` 端口即可
