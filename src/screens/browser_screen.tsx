import { useEffect, useState } from "react";
import { SettingsPopover } from "../security/settings_popover";
import { LockIcon, ServerIcon } from "../icons";
import { ContextMenu } from "../browse/context_menu_view";
import { DragLayer } from "../browse/drag_drop_view";
import { listenOsDrop } from "../browse/os_drop";
import { FilePanel } from "../browse/file_panel";
import { PanelSplitter, splitColumns } from "../browse/panel_splitter";
import { listBuckets, listProfiles, type Profile } from "../browse/browse_api";
import { useBrowseStore } from "../browse/browse_store";
import { openSource } from "../browse/panel_loader";
import { installFocusReload, installReloadKey } from "../browse/reload_triggers";
import { TransferQueuePanel } from "../queue/queue_panel";
import { OpsDialogs } from "../ops/ops_dialogs";
import { startDelete, startNewFolder, startRename, startTransfer } from "../ops/ops_flow";
import { useOpsStore } from "../ops/ops_store";
import { presignSelection } from "../ops/ops_targets";
import { startPresign } from "../ops/presign_flow";
import { ToastView } from "../ops/toast";
import { startViewer } from "../viewer/viewer_flow";
import { ViewerHost } from "../viewer/viewer_host";
import { useViewerStore } from "../viewer/viewer_store";

const PRESIGN_KEY = "F9";
const FUNCTION_KEYS: { key: string; label: string; action?: () => void }[] = [
  { key: "F2", label: "Rename", action: () => startRename() },
  { key: "F3", label: "View", action: () => void startViewer("view") },
  { key: "F4", label: "Edit", action: () => void startViewer("edit") },
  { key: "F5", label: "Copy", action: () => void startTransfer("copy") },
  { key: "F6", label: "Move", action: () => void startTransfer("move") },
  { key: "F7", label: "New folder", action: () => startNewFolder() },
  { key: "F8", label: "Delete", action: () => startDelete() },
  { key: PRESIGN_KEY, label: "Presign", action: () => startPresign() },
];

export function BrowserScreen({ onManageProfiles, onLock }: { onManageProfiles: () => void; onLock: () => void }) {
  const profileId = useBrowseStore((state) => state.profileId);
  const splitRatio = useBrowseStore((state) => state.splitRatio);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [topError, setTopError] = useState("");
  // F9 needs a server panel with something selected (marked items, else the cursor item).
  const canPresign = useBrowseStore((state) => presignSelection(state[state.active]) !== null);

  // Profile list: pick the stored profile if it still exists, otherwise the first one.
  useEffect(() => {
    let cancelled = false;
    listProfiles()
      .then((list) => {
        if (cancelled) return;
        setProfiles(list);
        const store = useBrowseStore.getState();
        if (!list.some((profile) => profile.id === store.profileId)) store.setProfile(list[0]?.id ?? null);
      })
      .catch((err) => !cancelled && setTopError(String(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  // Local panel starts at the home directory, only when it has no state yet (it survives remounts).
  useEffect(() => {
    if (useBrowseStore.getState().left.source === null) void openSource("left", { kind: "local" });
  }, []);

  // Buckets of the active profile; the right panel opens the first one if it is still empty.
  useEffect(() => {
    if (!profileId) return;
    let cancelled = false;
    setTopError("");
    listBuckets(profileId)
      .then((names) => {
        if (cancelled) return;
        const store = useBrowseStore.getState();
        store.setBuckets(names);
        if (store.right.source === null && names.length) void openSource("right", { kind: "bucket", bucket: names[0] });
      })
      .catch((err) => !cancelled && setTopError(String(err)));
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  // Drops from the OS file manager (Tauri webview drag-drop event) onto a server panel.
  useEffect(() => {
    const unlisten = listenOsDrop();
    return () => void unlisten.then((stop) => stop());
  }, []);

  // Function keys act on the active panel; open dialogs handle their own keys.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (useOpsStore.getState().dialog || useViewerStore.getState().session) return;
      const entry = FUNCTION_KEYS.find((candidate) => candidate.action && candidate.key === event.key);
      if (!entry?.action) return;
      event.preventDefault();
      entry.action();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Cmd/Ctrl+R reloads the active panel; Local panels also reload when the window regains focus.
  useEffect(() => {
    const stops = [installReloadKey(), installFocusReload()];
    return () => stops.forEach((stop) => stop());
  }, []);

  return (
    <div className="browser">
      <div className="bar">
        <span className="title"><span className="brand-mark"><ServerIcon /></span>S3 Commander</span>
        {topError && <span className="bar-error" role="alert">{topError}</span>}
        <label className="muted" htmlFor="profile-switcher">Profile</label>
        <select
          id="profile-switcher"
          value={profileId ?? ""}
          onChange={(event) => useBrowseStore.getState().setProfile(event.currentTarget.value || null)}
        >
          {profiles.length === 0 && <option value="">(no profiles)</option>}
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>{profile.name}</option>
          ))}
        </select>
        <button type="button" onClick={onManageProfiles}>Profiles</button>
        <SettingsPopover />
        <button type="button" onClick={onLock}><LockIcon />Lock</button>
      </div>
      <div className="panels" style={splitColumns(splitRatio)}>
        <FilePanel side="left" />
        <PanelSplitter />
        <FilePanel side="right" />
      </div>
      <TransferQueuePanel />
      <div className="fkeys">
        {FUNCTION_KEYS.map(({ key, label, action }) => (
          <button
            key={key}
            type="button"
            disabled={!action || (key === PRESIGN_KEY && !canPresign)}
            title={!action ? "Not available yet" : key === PRESIGN_KEY && !canPresign ? "Select files on a server panel" : undefined}
            onClick={() => !useOpsStore.getState().dialog && !useViewerStore.getState().session && action?.()}
          >
            <span className="fk">{key}</span>{label}
          </button>
        ))}
      </div>
      <div className="muted hint">Keys: Tab switches panel, Up/Down/PageUp/PageDown/Home/End move, Enter opens, Backspace goes up, Space marks, F2 renames, F3 views, F4 edits, F5 copies, F6 moves, F7 creates a folder, F8 deletes, F9 presigns a URL.</div>
      <ContextMenu />
      <DragLayer />
      <ToastView />
      <OpsDialogs />
      <ViewerHost />
    </div>
  );
}
