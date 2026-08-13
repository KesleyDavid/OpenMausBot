// The narrow bridge the Electron preload exposes. Absent in the browser.
export {};

declare global {
  type DesktopCapabilities = {
    host: {
      platform: "darwin" | "linux" | "win32" | "other";
      label: string;
      session: "x11" | "wayland" | "headless" | "unknown";
      packaged: boolean;
    };
    windowChrome: "mac-inset" | "native";
    screenPreview: {
      available: boolean;
      interaction: "direct" | "portal-picker" | "none";
      reasonCode?: string;
    };
    dictation: {
      available: boolean;
      engine: "apple-speech" | "none";
      onDevice: boolean;
      reasonCode?: string;
    };
    localComputer: {
      available: boolean;
      support: "supported" | "limited" | "unsupported";
      enabled: boolean;
      status: "disabled" | "checking" | "starting" | "ready" | "error" | "stopped" | "unavailable";
      reasonCode?: string;
      message?: string;
      driverPath?: string;
      driverVersion?: string;
    };
  };

  interface Window {
    ogb?: {
      platform: NodeJS.Platform;
      getCapabilities(): Promise<DesktopCapabilities>;
      onCapabilitiesChanged(cb: (capabilities: DesktopCapabilities) => void): () => void;
      localControl: {
        status(): Promise<LinuxLocalControlStatus>;
        enable(): Promise<LinuxLocalControlStatus>;
        disable(): Promise<LinuxLocalControlStatus>;
        retry(): Promise<LinuxLocalControlStatus>;
      };
      /** Arms one user-initiated display capture request from this frame. */
      beginScreenPreviewIntent(): boolean;
      screenFrame(): Promise<string | null>;
      speechStart(): Promise<void>;
      speechStop(): Promise<void>;
      onSpeechTranscript(
        cb: (line: { partial?: boolean; text?: string; error?: string }) => void,
      ): () => void;
      onSpeechEnd(cb: (info: { code: number | null; reason?: string }) => void): () => void;
      /** {mic} TCC status: granted|denied|not-determined|unknown. Screen
       * status is deliberately absent — macOS 15+ caches it per-process,
       * so it lies for the whole session after a grant. */
      permStatus(): Promise<{ mic: string }>;
      /** Triggers the macOS microphone prompt; resolves true when granted. */
      permRequestMic(): Promise<boolean>;
      /** Opens System Settings on a privacy pane: mic|screen|speech. */
      permOpenSettings(pane: "mic" | "screen" | "speech"): Promise<void>;
      /** In-app auto-update (packaged app only; dormant in dev). onState
       * fires immediately with the current state, then on transitions. */
      updater?: {
        check(): Promise<void>;
        download(): Promise<void>;
        /** quit-and-install the downloaded update */
        install(): Promise<void>;
        onState(cb: (s: UpdaterState) => void): () => void;
      };
    };
  }
}

export interface LinuxLocalControlStatus {
  enabled: boolean;
  status: "disabled" | "checking" | "starting" | "ready" | "error" | "stopped" | "unavailable";
  reasonCode?: string;
  message?: string;
  driverPath?: string;
  driverVersion?: string;
  warnings?: Array<{ label: string; status: string; message: string; detail?: string }>;
}

export interface UpdaterState {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "error";
  version?: string;
  percent?: number;
  message?: string;
}
