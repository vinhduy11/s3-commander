import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ServerIcon } from "../icons";
import { duplicateProfile, testProfile, type Profile } from "../browse/browse_api";
import type { FieldErrors } from "../profile/validate_profile";
import { ProfileForm, type ProfileFormValues } from "./profile_form";

// Rust returns { message, fields: [{ field, message }] } on a failed save; other commands a string.
type SaveFailure = { message?: string; fields?: { field: keyof FieldErrors; message: string }[] };

const EMPTY_FORM: ProfileFormValues = {
  id: "",
  name: "",
  endpoint: "",
  access_key: "",
  secret_key: "",
  region: "us-east-1",
};

export function ProfilesScreen({ onBack, onLock }: { onBack: () => void; onLock: () => void }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [form, setForm] = useState<ProfileFormValues | null>(null);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [savedId, setSavedId] = useState("");

  async function reload() {
    try {
      setProfiles(await invoke<Profile[]>("profile_list"));
    } catch (err) {
      setError(String(err));
    }
  }

  useEffect(() => {
    reload();
  }, []);

  async function save(values: ProfileFormValues) {
    try {
      const saved = await invoke<Profile>("profile_save", { profile: values });
      setForm(null);
      setServerErrors({});
      setError("");
      setNotice(`Saved "${saved.name}".`);
      setSavedId(saved.id);
      await reload();
    } catch (err) {
      const failure = err as SaveFailure;
      const fields = Object.fromEntries((failure.fields ?? []).map((item) => [item.field, item.message]));
      setServerErrors(fields);
      setError(Object.keys(fields).length > 0 ? "" : failure.message ?? String(err));
    }
  }

  async function remove(profileId: string) {
    try {
      await invoke("profile_delete", { profileId });
      await reload();
    } catch (err) {
      setError(String(err));
    }
  }

  async function test(profileId: string) {
    setSavedId("");
    setNotice("Testing...");
    setError("");
    try {
      const bucketCount = await testProfile(profileId);
      setNotice(`Connection works (${bucketCount} bucket(s))`);
    } catch (err) {
      setNotice("");
      setError(String(err));
    }
  }

  async function duplicate(profileId: string) {
    try {
      await duplicateProfile(profileId);
      await reload();
    } catch (err) {
      setError(String(err));
    }
  }

  function openForm(values: ProfileFormValues) {
    setServerErrors({});
    setError("");
    setSavedId("");
    setNotice("");
    setForm(values);
  }

  return (
    <main className="page">
      <div className="page-wide">
        <div className="page-head">
          <h1>Profiles</h1>
          <button onClick={onBack}>Back</button>
          <button onClick={onLock}>Lock</button>
          <button className="primary" onClick={() => openForm(EMPTY_FORM)}>Add profile</button>
        </div>
        {notice && (
          <p className="notice" role="status">
            {notice}
            {savedId && <button onClick={() => test(savedId)}>Test connection</button>}
          </p>
        )}
        {error && <p className="alert" role="alert">{error}</p>}
        {profiles.length === 0 && !form && <p className="empty">No profiles yet. Add one to connect to a MinIO server.</p>}
        {profiles.length > 0 && (
          <ul className="profile-list">
            {profiles.map((profile) => (
              <li key={profile.id} className="profile-item">
                <span className="profile-icon"><ServerIcon /></span>
                <span className="profile-main">
                  <span className="profile-name">{profile.name}</span>
                  <span className="profile-meta">{profile.endpoint} ({profile.access_key}, {profile.region})</span>
                </span>
                <span className="profile-actions">
                  <button onClick={() => openForm({ ...profile, secret_key: "" })}>Edit</button>
                  <button onClick={() => test(profile.id)}>Test</button>
                  <button onClick={() => duplicate(profile.id)}>Duplicate</button>
                  <button className="danger" onClick={() => remove(profile.id)}>Delete</button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {form && (
          <ProfileForm
            key={form.id || "new"}
            initial={form}
            others={profiles.filter((profile) => profile.id !== form.id).map((profile) => profile.name)}
            serverErrors={serverErrors}
            onSubmit={save}
            onCancel={() => setForm(null)}
          />
        )}
      </div>
    </main>
  );
}
