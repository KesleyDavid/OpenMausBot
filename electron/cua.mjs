// CUA computer-use wiring for the Electron main process.
//
// Two modes, per cua-driver's EMBEDDING.md:
//  - "embedded" (packaged app): spawn our own private daemon via
//    EmbeddedCuaDriverHost so TCC grants attribute to OpenMausBot and the
//    driver inherits them. One prompt, named OpenMausBot, out of the box.
//  - "standalone" (dev): attach to an already-installed CuaDriver.app daemon
//    (its own TCC identity, typically already granted on a dev machine).
//
// Agents never talk to the daemon socket directly — they spawn the official
// stdio MCP proxy: `cua-driver mcp [--embedded --socket <path>]`. The proxy
// executes nothing; the host-owned daemon does.
//
// The resulting connection descriptor is written to
// <userData>/cua-connection.json for the harness server to hand to drivers.

import { app, ipcMain } from "electron";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const require = createRequire(import.meta.url);
const { createCuaConnectionStore } = require("./cua-connection.cjs");
const { createLinuxCuaRuntime } = require("./cua-linux-runtime.cjs");

const INSTALLED_DRIVER = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
const STANDALONE_SOCKET = path.join(
  app.getPath("home"),
  "Library/Caches/cua-driver/cua-driver.sock",
);
const HOST_BUNDLE_ID = "com.openmausbot.app";

let embeddedHost = null; // EmbeddedCuaDriverHost | null
let linuxRuntime = null;
let stateListener = () => {};
const connectionStore = createCuaConnectionStore({
  getUserData: () => app.getPath("userData"),
});

function ensureLinuxRuntime() {
  if (!linuxRuntime) {
    linuxRuntime = createLinuxCuaRuntime({
      getUserData: () => app.getPath("userData"),
      connectionStore,
      onChange: (connection) => stateListener(connection),
    });
  }
  return linuxRuntime;
}

export function setCuaStateListener(listener) {
  stateListener = typeof listener === "function" ? listener : () => {};
}

export function resolveDriverBinary() {
  if (process.env.CUA_DRIVER_PATH) return process.env.CUA_DRIVER_PATH;
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "cua-driver");
    if (fs.existsSync(bundled)) return bundled;
  }
  if (fs.existsSync(INSTALLED_DRIVER)) return INSTALLED_DRIVER;
  return null;
}

function socketAlive(sockPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(sockPath)) return resolve(false);
    const s = net.createConnection(sockPath);
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    setTimeout(() => done(false), 1500).unref();
  });
}

async function startEmbedded(binary) {
  // Dynamic import: the SDK ships a native FFI lib; keep dev startup
  // resilient if it fails to load on this machine.
  const { EmbeddedCuaDriverHost } = await import("@trycua/cua-driver/embedded");
  embeddedHost = new EmbeddedCuaDriverHost(binary, HOST_BUNDLE_ID);
  const conn = await embeddedHost.start();
  return {
    mode: "embedded",
    socketPath: conn.socketPath,
    mcpCommand: binary,
    mcpArgs: ["mcp", "--embedded", "--socket", conn.socketPath],
    mcpEnv: { CUA_DRIVER_EMBEDDED: "1", CUA_DRIVER_HOST_BUNDLE_ID: HOST_BUNDLE_ID },
  };
}

export async function startCua() {
  if (process.platform === "linux") return ensureLinuxRuntime().initialize();
  const binary = resolveDriverBinary();
  if (!binary) {
    return connectionStore.persist({
      mode: "unavailable",
      reason: "cua-driver binary not found",
    });
  }

  const wantEmbedded =
    app.isPackaged || process.env.OPENMAUSBOT_CUA_EMBEDDED === "1";
  let nextConnection;

  if (wantEmbedded) {
    try {
      nextConnection = await startEmbedded(binary);
    } catch (err) {
      nextConnection = {
        mode: "unavailable",
        reason: `embedded host failed: ${err?.message ?? err}`,
      };
    }
  } else if (await socketAlive(STANDALONE_SOCKET)) {
    // Dev machine with CuaDriver.app's daemon already running.
    nextConnection = {
      mode: "standalone",
      socketPath: STANDALONE_SOCKET,
      mcpCommand: binary,
      mcpArgs: ["mcp"],
      mcpEnv: {},
    };
  } else {
    nextConnection = {
      mode: "unavailable",
      reason:
        "no running cua-driver daemon; run `cua-driver serve` or grant via `cua-driver permissions grant`",
    };
  }

  return connectionStore.persist(nextConnection);
}

export function cuaPermissionsStatus() {
  const binary = resolveDriverBinary();
  if (!binary) return { available: false };
  const out = spawnSync(binary, ["permissions", "status", "--json"], {
    encoding: "utf8",
    timeout: 5000,
  });
  try {
    return { available: true, ...JSON.parse(out.stdout) };
  } catch {
    return { available: true, raw: out.stdout?.trim() };
  }
}

export async function stopCua() {
  if (linuxRuntime) {
    await linuxRuntime.shutdown();
    return;
  }
  if (embeddedHost) {
    try {
      await embeddedHost.stop();
      embeddedHost.uniffiDestroy?.();
    } catch {
      // daemon holds a parent-liveness pipe; host death closes it anyway
    }
    embeddedHost = null;
  }
  if (connectionStore.get()) {
    connectionStore.persist({ mode: "unavailable", reason: "desktop-host-stopped" });
  }
}

export function registerCuaIpc() {
  ipcMain.handle("cua:connection", () => connectionStore.get());
  ipcMain.handle("cua:permissions", () => cuaPermissionsStatus());
  ipcMain.handle("cua:linux-status", () =>
    process.platform === "linux"
      ? ensureLinuxRuntime().getStatus()
      : { enabled: false, status: "unavailable", reasonCode: "unsupported-platform" },
  );
  ipcMain.handle("cua:linux-enable", async () => {
    if (process.platform !== "linux") {
      return { enabled: false, status: "unavailable", reasonCode: "unsupported-platform" };
    }
    await ensureLinuxRuntime().enable();
    return ensureLinuxRuntime().getStatus();
  });
  ipcMain.handle("cua:linux-disable", async () => {
    if (process.platform !== "linux") {
      return { enabled: false, status: "unavailable", reasonCode: "unsupported-platform" };
    }
    await ensureLinuxRuntime().disable();
    return ensureLinuxRuntime().getStatus();
  });
  ipcMain.handle("cua:linux-retry", async () => {
    if (process.platform !== "linux") {
      return { enabled: false, status: "unavailable", reasonCode: "unsupported-platform" };
    }
    await ensureLinuxRuntime().retry();
    return ensureLinuxRuntime().getStatus();
  });
}
