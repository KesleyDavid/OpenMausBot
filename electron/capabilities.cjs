// Pure desktop capability detection shared by Electron main tests and the
// renderer contract. Keep this file free of Electron imports so every branch
// is deterministic and unit-testable.

const DESKTOP_PLATFORMS = new Set(["darwin", "linux", "win32"]);

function normalizedPlatform(platform) {
  return DESKTOP_PLATFORMS.has(platform) ? platform : "other";
}

function linuxSession(platform, env) {
  if (platform !== "linux") return "unknown";
  const declared = String(env.XDG_SESSION_TYPE ?? "").toLowerCase();
  if (declared === "wayland") return "wayland";
  if (declared === "x11" || declared === "xorg") return "x11";
  // A Wayland user session may also expose DISPLAY for XWayland. Prefer the
  // Wayland signal so the UI never bypasses portal-mediated behavior.
  if (env.WAYLAND_DISPLAY) return "wayland";
  if (env.DISPLAY) return "x11";
  return "headless";
}

function localComputerReady(platform, connection) {
  if (platform === "darwin") {
    return connection?.mode === "embedded" || connection?.mode === "standalone";
  }
  return (
    platform === "linux" &&
    connection?.schemaVersion === 1 &&
    connection?.mode === "linux-x11-supervised" &&
    connection?.platform === "linux" &&
    connection?.session === "x11" &&
    connection?.enabled === true &&
    connection?.status === "ready"
  );
}

function desktopCapabilities({
  platform = process.platform,
  env = process.env,
  packaged = false,
  localConnection = null,
} = {}) {
  const hostPlatform = normalizedPlatform(platform);
  const isMac = hostPlatform === "darwin";
  const hostSession = linuxSession(hostPlatform, env);
  const linuxPreview = hostPlatform === "linux" && hostSession !== "headless";
  const localAvailable = localComputerReady(hostPlatform, localConnection);

  return {
    host: {
      platform: hostPlatform,
      label:
        hostPlatform === "darwin"
          ? "macOS"
          : hostPlatform === "linux"
            ? "Linux"
            : hostPlatform === "win32"
              ? "Windows"
              : "Desktop",
      session: hostSession,
      packaged: Boolean(packaged),
    },
    windowChrome: isMac ? "mac-inset" : "native",
    screenPreview: {
      available: isMac || linuxPreview,
      interaction: isMac || hostSession === "x11" ? "direct" : hostSession === "wayland" ? "portal-picker" : "none",
      ...(!(isMac || linuxPreview)
        ? {
            reasonCode:
              hostPlatform === "linux" ? "headless-session" : "unsupported-platform",
          }
        : {}),
    },
    dictation: {
      available: isMac,
      engine: isMac ? "apple-speech" : "none",
      onDevice: isMac,
      ...(!isMac ? { reasonCode: "unsupported-platform" } : {}),
    },
    localComputer: {
      available: localAvailable,
      support: localAvailable && hostPlatform === "linux" ? "limited" : localAvailable ? "supported" : "unsupported",
      enabled: connectionEnabled(hostPlatform, localConnection),
      status: localAvailable ? "ready" : localConnection?.status ?? "unavailable",
      ...(typeof localConnection?.message === "string" ? { message: localConnection.message } : {}),
      ...(typeof localConnection?.driver?.path === "string"
        ? { driverPath: localConnection.driver.path }
        : {}),
      ...(typeof localConnection?.driver?.version === "string"
        ? { driverVersion: localConnection.driver.version }
        : {}),
      ...(!localAvailable
        ? {
            reasonCode:
              localConnection?.reasonCode ??
              (hostPlatform === "darwin" ? "cua-driver-unavailable" : "unsupported-platform"),
          }
        : {}),
    },
  };
}

function connectionEnabled(platform, connection) {
  if (platform === "darwin") return localComputerReady(platform, connection);
  return platform === "linux" && connection?.enabled === true;
}

module.exports = { connectionEnabled, desktopCapabilities, linuxSession, localComputerReady };
