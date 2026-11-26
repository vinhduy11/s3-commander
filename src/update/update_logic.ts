// Pure state machine of the update flow. No Tauri, no React: the store feeds it events.

export type UpdatePhase = "idle" | "checking" | "up_to_date" | "available" | "downloading" | "installed" | "error";

export type UpdateState = {
  phase: UpdatePhase;
  version: string;
  currentVersion: string;
  notes: string;
  downloaded: number;
  /** null when the server did not say how big the download is. */
  total: number | null;
  error: string;
};

export type FoundUpdate = { version: string; currentVersion: string; notes: string };

/** The updater plugin's download events (same shape as `DownloadEvent` in `@tauri-apps/plugin-updater`). */
export type DownloadProgress =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export type UpdateEvent =
  | { type: "check_started" }
  | { type: "check_finished"; update: FoundUpdate | null }
  | { type: "check_failed"; message: string; silent: boolean }
  | { type: "download_started" }
  | { type: "download_event"; event: DownloadProgress }
  | { type: "installed" }
  | { type: "install_failed"; message: string }
  | { type: "error_closed"; hasPending: boolean };

export const initialUpdateState: UpdateState = {
  phase: "idle",
  version: "",
  currentVersion: "",
  notes: "",
  downloaded: 0,
  total: null,
  error: "",
};

export function reduceUpdate(state: UpdateState, event: UpdateEvent): UpdateState {
  switch (event.type) {
    case "check_started":
      // A running download or a finished install must not be interrupted by a check.
      return state.phase === "downloading" || state.phase === "installed" ? state : { ...state, phase: "checking", error: "" };
    case "check_finished":
      return event.update
        ? { ...initialUpdateState, ...event.update, phase: "available" }
        : { ...initialUpdateState, phase: "up_to_date" };
    case "check_failed":
      return event.silent ? { ...state, phase: "idle", error: "" } : { ...state, phase: "error", error: event.message };
    case "download_started":
      return { ...state, phase: "downloading", downloaded: 0, total: null, error: "" };
    case "download_event":
      return applyDownload(state, event.event);
    case "installed":
      return { ...state, phase: "installed" };
    case "install_failed":
      return { ...state, phase: "error", error: event.message };
    case "error_closed":
      return { ...state, phase: event.hasPending ? "available" : "idle", error: "" };
  }
}

function applyDownload(state: UpdateState, event: DownloadProgress): UpdateState {
  if (event.event === "Started") return { ...state, downloaded: 0, total: event.data.contentLength ?? null };
  if (event.event === "Progress") return { ...state, downloaded: state.downloaded + event.data.chunkLength };
  return state.total === null ? state : { ...state, downloaded: state.total };
}

/** 0..100, or null when the size is unknown (show an indeterminate bar). */
export function percentOf(state: UpdateState): number | null {
  if (state.total === null || state.total <= 0) return null;
  return Math.min(100, Math.round((state.downloaded * 100) / state.total));
}

/** The quiet launch check: release builds only, when the setting is on, once per launch. */
export const shouldCheckAtLaunch = (gate: { dev: boolean; enabled: boolean; alreadyChecked: boolean }): boolean =>
  !gate.dev && gate.enabled && !gate.alreadyChecked;

/** One line for the Settings popover. */
export function statusLine(state: UpdateState): string {
  switch (state.phase) {
    case "checking":
      return "Checking for updates...";
    case "up_to_date":
      return "You are up to date.";
    case "available":
      return `Update ${state.version} available.`;
    case "downloading":
      return `Downloading update ${state.version}...`;
    case "installed":
      return `Update ${state.version} is installed. Restart to use it.`;
    case "error":
      return state.error;
    default:
      return "";
  }
}
