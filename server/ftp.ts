import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import net, { type AddressInfo, type Server, type Socket } from "node:net";
import path from "node:path";
import { pipeline } from "node:stream/promises";

type PassiveState = {
  server: Server;
  socket?: Socket;
  promise: Promise<Socket>;
  resolve: (socket: Socket) => void;
  reject: (error: Error) => void;
};

type FtpShareState = {
  active: boolean;
  port: number;
  rootDir: string;
  error?: string;
};

const defaultFtpPort = Number(process.env.SHARE_FTP_PORT ?? process.env.FTP_SHARE_PORT ?? 2121);
let ftpShareServer: Server | undefined;
let ftpShareState: FtpShareState = {
  active: false,
  port: defaultFtpPort,
  rootDir: path.resolve("media")
};

export function getReadOnlyFtpShareState() {
  return { ...ftpShareState };
}

export async function startReadOnlyFtpShare(rootDir: string, port = defaultFtpPort) {
  if (ftpShareServer) return getReadOnlyFtpShareState();

  const resolvedRoot = path.resolve(rootDir);
  ftpShareState = {
    active: false,
    port,
    rootDir: resolvedRoot
  };

  const server = net.createServer((socket) => {
    new ReadOnlyFtpSession(socket, resolvedRoot).start();
  });

  server.on("error", (error) => {
    ftpShareState = {
      active: false,
      port,
      rootDir: resolvedRoot,
      error: error instanceof Error ? error.message : "FTP share failed"
    };
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });
    ftpShareServer = server;
    ftpShareState = {
      active: true,
      port,
      rootDir: resolvedRoot
    };
  } catch (error) {
    server.close();
    ftpShareState = {
      active: false,
      port,
      rootDir: resolvedRoot,
      error: error instanceof Error ? error.message : "FTP share failed"
    };
  }

  return getReadOnlyFtpShareState();
}

class ReadOnlyFtpSession {
  private buffer = "";
  private cwd = "/";
  private passive?: PassiveState;
  private restartOffset = 0;

  constructor(
    private readonly socket: Socket,
    private readonly rootDir: string
  ) {}

  start() {
    this.socket.setEncoding("utf8");
    this.reply(220, "Movie Hub read-only FTP share ready");
    this.socket.on("data", (chunk) => this.read(String(chunk)));
    this.socket.on("error", () => this.cleanup());
    this.socket.on("close", () => this.cleanup());
  }

  private read(chunk: string) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) void this.handle(trimmed);
    }
  }

  private async handle(line: string) {
    const [rawCommand, ...rest] = line.split(" ");
    const command = rawCommand.toUpperCase();
    const argument = rest.join(" ").trim();

    try {
      switch (command) {
        case "USER":
          this.reply(331, "Anonymous access allowed");
          break;
        case "PASS":
          this.reply(230, "Logged in");
          break;
        case "SYST":
          this.reply(215, "UNIX Type: L8");
          break;
        case "FEAT":
          this.multiline(211, ["UTF8", "EPSV", "PASV", "SIZE", "MDTM"], "End");
          break;
        case "OPTS":
          this.reply(200, "Option accepted");
          break;
        case "PWD":
          this.reply(257, `"${this.cwd}" is the current directory`);
          break;
        case "CWD":
          await this.changeDirectory(argument);
          break;
        case "CDUP":
          await this.changeDirectory("..");
          break;
        case "TYPE":
        case "MODE":
        case "STRU":
          this.reply(200, "OK");
          break;
        case "PASV":
          await this.enterPassiveMode(false);
          break;
        case "EPSV":
          await this.enterPassiveMode(true);
          break;
        case "LIST":
          await this.list(argument, true);
          break;
        case "NLST":
          await this.list(argument, false);
          break;
        case "RETR":
          await this.retrieve(argument);
          break;
        case "SIZE":
          await this.size(argument);
          break;
        case "MDTM":
          await this.modifiedTime(argument);
          break;
        case "REST":
          this.setRestartOffset(argument);
          break;
        case "NOOP":
          this.reply(200, "OK");
          break;
        case "QUIT":
          this.reply(221, "Goodbye");
          this.socket.end();
          break;
        case "PORT":
        case "EPRT":
          this.reply(502, "Use PASV or EPSV");
          break;
        case "STOR":
        case "APPE":
        case "DELE":
        case "RMD":
        case "MKD":
        case "RNFR":
        case "RNTO":
          this.reply(550, "Read-only share");
          break;
        default:
          this.reply(502, "Command not implemented");
      }
    } catch (error) {
      this.reply(550, error instanceof Error ? error.message : "FTP operation failed");
    }
  }

  private async changeDirectory(target: string) {
    const resolved = this.resolvePath(target || "/");
    const info = await stat(resolved.filePath);
    if (!info.isDirectory()) {
      this.reply(550, "Not a directory");
      return;
    }
    this.cwd = resolved.virtualPath;
    this.reply(250, "Directory changed");
  }

  private async list(argument: string, detailed: boolean) {
    const target = stripListOptions(argument);
    const resolved = this.resolvePath(target || this.cwd);
    const info = await stat(resolved.filePath);
    const data = await this.dataSocket();
    if (!data) return;

    this.reply(150, "Opening directory listing");
    if (info.isDirectory()) {
      const children = await readdir(resolved.filePath, { withFileTypes: true });
      const lines = await Promise.all(
        children.map(async (entry) => {
          if (!detailed) return entry.name;
          const childPath = path.join(resolved.filePath, entry.name);
          const childInfo = await stat(childPath);
          return formatListEntry(entry.name, childInfo);
        })
      );
      data.end(`${lines.join("\r\n")}\r\n`);
    } else {
      data.end(`${detailed ? formatListEntry(path.basename(resolved.filePath), info) : path.basename(resolved.filePath)}\r\n`);
    }
    await onceClosed(data);
    await this.closePassive();
    this.reply(226, "Directory send OK");
  }

  private async retrieve(target: string) {
    const resolved = this.resolvePath(target);
    const info = await stat(resolved.filePath);
    if (info.isDirectory()) {
      this.reply(550, "Cannot retrieve a directory");
      return;
    }

    const data = await this.dataSocket();
    if (!data) return;

    const offset = Math.max(0, Math.min(this.restartOffset, info.size - 1));
    this.restartOffset = 0;
    this.reply(150, "Opening binary mode data connection");
    await pipeline(createReadStream(resolved.filePath, { start: offset }), data);
    await this.closePassive();
    this.reply(226, "Transfer complete");
  }

  private async size(target: string) {
    const resolved = this.resolvePath(target);
    const info = await stat(resolved.filePath);
    if (info.isDirectory()) {
      this.reply(550, "Cannot size a directory");
      return;
    }
    this.reply(213, String(info.size));
  }

  private async modifiedTime(target: string) {
    const resolved = this.resolvePath(target);
    const info = await stat(resolved.filePath);
    this.reply(213, ftpTimestamp(info.mtime));
  }

  private setRestartOffset(argument: string) {
    const offset = Number.parseInt(argument, 10);
    if (Number.isNaN(offset) || offset < 0) {
      this.reply(501, "Invalid restart offset");
      return;
    }
    this.restartOffset = offset;
    this.reply(350, "Restart position accepted");
  }

  private async enterPassiveMode(extended: boolean) {
    await this.closePassive();

    let resolveSocket: PassiveState["resolve"] = () => undefined;
    let rejectSocket: PassiveState["reject"] = () => undefined;
    const promise = new Promise<Socket>((resolve, reject) => {
      resolveSocket = resolve;
      rejectSocket = reject;
    });

    const server = net.createServer((dataSocket) => {
      if (this.passive?.socket) {
        dataSocket.destroy();
        return;
      }
      this.passive!.socket = dataSocket;
      resolveSocket(dataSocket);
      server.close();
    });

    this.passive = {
      server,
      promise,
      resolve: resolveSocket,
      reject: rejectSocket
    };

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = server.address() as AddressInfo;
    if (extended) {
      this.reply(229, `Entering Extended Passive Mode (|||${address.port}|)`);
      return;
    }

    const host = passiveHost(this.socket.localAddress);
    const p1 = Math.floor(address.port / 256);
    const p2 = address.port % 256;
    this.reply(227, `Entering Passive Mode (${host.replace(/\./g, ",")},${p1},${p2})`);
  }

  private async dataSocket() {
    if (!this.passive) {
      this.reply(425, "Use PASV or EPSV first");
      return undefined;
    }

    try {
      return await withTimeout(this.passive.promise, 15_000);
    } catch {
      await this.closePassive();
      this.reply(425, "Data connection timed out");
      return undefined;
    }
  }

  private resolvePath(target: string) {
    const decodedTarget = safeDecode(target.trim());
    const nextVirtual = decodedTarget.startsWith("/")
      ? decodedTarget
      : path.posix.join(this.cwd, decodedTarget || ".");
    const normalized = path.posix.normalize(nextVirtual);
    const relative = normalized === "/" ? "" : normalized.replace(/^\/+/, "");
    const filePath = path.resolve(this.rootDir, relative);
    const rootRelative = path.relative(this.rootDir, filePath);
    if (rootRelative.startsWith("..") || path.isAbsolute(rootRelative)) {
      throw new Error("Path is outside media directory");
    }
    return {
      filePath,
      virtualPath: `/${rootRelative.replace(/\\/g, "/")}`.replace(/\/$/, "") || "/"
    };
  }

  private reply(code: number, message: string) {
    this.socket.write(`${code} ${message}\r\n`);
  }

  private multiline(code: number, lines: string[], end = "End") {
    this.socket.write(`${code}-${end}\r\n`);
    for (const line of lines) this.socket.write(` ${line}\r\n`);
    this.socket.write(`${code} ${end}\r\n`);
  }

  private async closePassive() {
    const passive = this.passive;
    this.passive = undefined;
    if (!passive) return;
    passive.socket?.destroy();
    await new Promise<void>((resolve) => passive.server.close(() => resolve())).catch(() => undefined);
  }

  private cleanup() {
    void this.closePassive();
  }
}

function stripListOptions(argument: string) {
  const parts = argument.split(/\s+/).filter(Boolean);
  while (parts[0]?.startsWith("-")) parts.shift();
  return parts.join(" ");
}

function formatListEntry(name: string, info: Awaited<ReturnType<typeof stat>>) {
  const permissions = info.isDirectory() ? "dr-xr-xr-x" : "-r--r--r--";
  const size = String(info.size).padStart(12, " ");
  return `${permissions} 1 moviehub moviehub ${size} ${listDate(info.mtime)} ${name}`;
}

function listDate(date: Date) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const now = new Date();
  const old = Math.abs(now.getTime() - date.getTime()) > 180 * 24 * 60 * 60 * 1000;
  const month = months[date.getMonth()];
  const day = String(date.getDate()).padStart(2, " ");
  if (old) return `${month} ${day}  ${date.getFullYear()}`;
  return `${month} ${day} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function ftpTimestamp(date: Date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    String(date.getUTCHours()).padStart(2, "0"),
    String(date.getUTCMinutes()).padStart(2, "0"),
    String(date.getUTCSeconds()).padStart(2, "0")
  ].join("");
}

function passiveHost(value?: string) {
  if (!value || value === "::" || value === "0.0.0.0") return "127.0.0.1";
  if (value.startsWith("::ffff:")) return value.slice(7);
  if (net.isIPv4(value)) return value;
  return "127.0.0.1";
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function onceClosed(socket: Socket) {
  return new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("close", () => resolve());
  });
}
