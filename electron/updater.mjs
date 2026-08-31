// In-app auto-updater (electron-updater). Downloads are user-driven; macOS
// stages the downloaded ZIP immediately and the explicit restart applies it.
// One state object is broadcast on every transition.
//
// Only runs in the packaged, signed+notarized app (mac auto-update requires
// signing). In dev it's a no-op so the browser/dev shell is unaffected.
// electron-updater is vendored (electron/vendor/electron-updater.cjs) because
// the packaged app ships no node_modules.
import { app, ipcMain, shell } from "electron";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";

const require = createRequire(import.meta.url);

let autoUpdater = null;
let win = null;
// status: idle | checking | available | downloading | downloaded | installing | error
let state = { status: "idle" };
let updaterCoordinator = null;

function updaterLogger() {
  const directory = app.getPath("logs");
  const file = join(directory, "updater.log");
  const write = (level, values) => {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const message = values
        .map((value) => (value instanceof Error ? value.stack ?? value.message : String(value)))
        .join(" ");
      appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${message}\n`, { mode: 0o600 });
    } catch {
      // Logging must never make updating unavailable.
    }
  };
  return Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [level, (...values) => write(level, values)]));
}

// Which Linux artifact is running. electron-updater resolves its installer the
// same way (resources/package-type first, APPIMAGE env as the fallback), so
// mirroring it here keeps the banner's promise and the updater's behaviour in
// step. Returns null off Linux and for an unpackaged tree.
function linuxPackageType() {
  if (process.platform !== "linux") return null;
  try {
    const identity = join(process.resourcesPath, "package-type");
    if (existsSync(identity)) {
      const declared = readFileSync(identity, "utf8").trim();
      if (declared) return declared;
    }
  } catch {
    // An unreadable marker is not worth failing the updater over — fall
    // through to the AppImage probe and treat the build as portable.
  }
  return process.env.APPIMAGE ? "AppImage" : null;
}

// A system package is the distro's to install, not ours. Left to
// electron-updater, a .deb update raises a polkit root prompt out of a chat
// app, runs `dpkg -i` (which resolves no dependencies) and replaces
// /opt/OpenMausBot while this very process is still running. Hand the
// downloaded package to the desktop instead and let the user finish there.
const HAND_OFF_PACKAGE_TYPES = new Set(["deb", "rpm", "pacman"]);

async function openDownloadedPackage(files) {
  const target = files?.find((file) => typeof file === "string" && file.length > 0);
  if (!target) {
    throw new Error("The downloaded package is no longer available. Download it again.");
  }
  // Empty string means the desktop took it; anything else is the failure
  // reason. With no handler registered for the package type, showing the file
  // still leaves the user somewhere they can act.
  const failure = await shell.openPath(target);
  if (failure) shell.showItemInFolder(target);
}

function setState(patch) {
  state = { ...state, ...patch };
  try {
    win?.webContents?.send("update:state", state);
  } catch {
    /* window gone */
  }
}

export function registerUpdaterIpc() {
  ipcMain.handle("update:get-state", () => state);
  ipcMain.handle("update:check", () => updaterCoordinator?.check(true));
  ipcMain.handle("update:download", () => updaterCoordinator?.download());
  ipcMain.handle("update:install", () => updaterCoordinator?.install());
}

export function startUpdater(mainWindow) {
  win = mainWindow;
  // dev / unsigned builds can't auto-update — leave the banner dormant
  if (!app.isPackaged) {
    updaterCoordinator = null;
    setState({ status: "idle" });
    return;
  }
  try {
    ({ autoUpdater } = require("./vendor/electron-updater.cjs"));
  } catch {
    updaterCoordinator = null;
    setState({ status: "error", message: "updater unavailable" });
    return;
  }
  autoUpdater.autoDownload = false; // button-driven download
  // Squirrel.Mac has a second, native staging pass after the ZIP download.
  // Start it immediately so "Restart to update" never has to begin that slow
  // pass and wait indefinitely. Windows keeps the explicit installer click.
  autoUpdater.autoInstallOnAppQuit = process.platform === "darwin";
  autoUpdater.logger = updaterLogger();

  // Broadcast the install flavour before the first check so the banner never
  // offers a restart it cannot deliver.
  const handOff = HAND_OFF_PACKAGE_TYPES.has(linuxPackageType());
  setState({ installMode: handOff ? "handoff" : "restart" });
  updaterCoordinator = createUpdaterCoordinator(autoUpdater, setState, {
    handOffInstall: handOff ? openDownloadedPackage : null,
  });

  // first check ~15s after launch (let the app settle), then hourly — both
  // silent on failure, hence the arrow: a bare `check` would receive the
  // timer's argument as `manual` and start reporting errors again.
  setTimeout(() => void updaterCoordinator?.check(), 15_000).unref?.();
  setInterval(() => void updaterCoordinator?.check(), 60 * 60 * 1000).unref?.();
}
