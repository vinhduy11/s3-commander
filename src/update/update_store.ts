// Update flow state: the pure machine plus the dialog, the "transfer running" warning and the
// wait for the queue. The plugin's Update object is not serializable, so it lives outside the state.

import { create } from "zustand";
import { isFinished } from "../queue/queue_logic";
import { useQueueStore } from "../queue/queue_store";
import { useSettingsStore } from "../security/settings_store";
import { checkForUpdate, readableError, restartApp, type PendingUpdate } from "./update_api";
import { initialUpdateState, reduceUpdate, shouldCheckAtLaunch, type UpdateEvent, type UpdateState } from "./update_logic";

type UpdateStore = {
  update: UpdateState;
  dialogOpen: boolean;
  /** Install was pressed while a transfer runs: the dialog asks what to do. */
  transferWarning: boolean;
  /** Waiting for the queue to go idle, then installing. */
  waiting: boolean;
  launchChecked: boolean;
  checkManual: () => Promise<void>;
  checkAtLaunch: (options?: { dev?: boolean }) => Promise<void>;
  openDialog: () => void;
  closeDialog: () => void;
  install: () => Promise<void>;
  installAnyway: () => Promise<void>;
  waitForTransfers: () => void;
  stopWaiting: () => void;
  restart: () => Promise<void>;
  reset: () => void;
};

const initial = { update: initialUpdateState, dialogOpen: false, transferWarning: false, waiting: false, launchChecked: false };

let pending: PendingUpdate | null = null;
let stopWatchingQueue: (() => void) | null = null;

const transfersActive = () => useQueueStore.getState().jobs.some((job) => !isFinished(job.snapshot.state));

export const useUpdateStore = create<UpdateStore>((set, get) => {
  const dispatch = (event: UpdateEvent) => set((state) => ({ update: reduceUpdate(state.update, event) }));

  async function runCheck(silent: boolean) {
    dispatch({ type: "check_started" });
    if (get().update.phase !== "checking") return; // a download or a finished install is in the way
    try {
      pending = await checkForUpdate();
      dispatch({ type: "check_finished", update: pending?.found ?? null });
    } catch (err) {
      dispatch({ type: "check_failed", message: readableError(err), silent });
    }
  }

  async function download() {
    if (!pending) return;
    set({ transferWarning: false, waiting: false });
    dispatch({ type: "download_started" });
    try {
      await pending.install((event) => dispatch({ type: "download_event", event }));
      dispatch({ type: "installed" });
    } catch (err) {
      dispatch({ type: "install_failed", message: readableError(err) });
    }
  }

  function stopQueueWatch() {
    stopWatchingQueue?.();
    stopWatchingQueue = null;
  }

  return {
    ...initial,
    checkManual: () => runCheck(false),
    checkAtLaunch: async ({ dev = import.meta.env.DEV } = {}) => {
      const gate = { dev, enabled: useSettingsStore.getState().checkUpdatesAtLaunch, alreadyChecked: get().launchChecked };
      if (!shouldCheckAtLaunch(gate)) return;
      set({ launchChecked: true });
      await runCheck(true);
    },
    openDialog: () => set({ dialogOpen: true }),
    closeDialog: () => {
      const phase = get().update.phase;
      if (phase === "downloading") return; // the plugin has no way to cancel a download
      stopQueueWatch();
      set({ dialogOpen: false, transferWarning: false, waiting: false });
      if (phase === "error") dispatch({ type: "error_closed", hasPending: pending !== null });
    },
    install: async () => {
      if (transfersActive()) return set({ transferWarning: true });
      await download();
    },
    installAnyway: () => {
      stopQueueWatch();
      return download();
    },
    waitForTransfers: () => {
      set({ transferWarning: false, waiting: true });
      stopQueueWatch();
      stopWatchingQueue = useQueueStore.subscribe(() => {
        if (transfersActive()) return;
        stopQueueWatch();
        void download();
      });
    },
    stopWaiting: () => {
      stopQueueWatch();
      set({ waiting: false, dialogOpen: false });
    },
    restart: () => restartApp(),
    reset: () => {
      stopQueueWatch();
      pending = null;
      set(initial);
    },
  };
});
