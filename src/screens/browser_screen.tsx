import { useEffect, useState } from "react";
import { LockIcon, ServerIcon } from "../icons";
import { FilePanel } from "../browse/file_panel";
import { listBuckets, listProfiles, type Profile } from "../browse/browse_api";
import { useBrowseStore } from "../browse/browse_store";
import { openSource } from "../browse/panel_loader";

const FUNCTION_KEYS = ["F3 View", "F4 Edit", "F5 Copy", "F6 Move", "F7 New folder", "F8 Delete"];

export function BrowserScreen({ onManageProfiles, onLock }: { onManageProfiles: () => void; onLock: () => void }) {
  const profileId = useBrowseStore((state) => state.profileId);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [topError, setTopError] = useState("");

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
        <button type="button" onClick={onLock}><LockIcon />Lock</button>
      </div>
      <div className="panels">
        <FilePanel side="left" />
        <FilePanel side="right" />
      </div>
      <div className="fkeys">
        {FUNCTION_KEYS.map((label) => {
          const [key, ...rest] = label.split(" ");
          return (
            <button key={label} type="button" disabled title="Not available yet">
              <span className="fk">{key}</span>{rest.join(" ")}
            </button>
          );
        })}
      </div>
      <div className="muted hint">Keys: Tab switches panel, Up/Down/PageUp/PageDown/Home/End move, Enter opens, Backspace goes up, Space marks.</div>
    </div>
  );
}
