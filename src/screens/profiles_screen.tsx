import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ServerIcon } from "../icons";
import { duplicateProfile, testProfile, type Profile } from "../browse/browse_api";

type ProfileForm = Profile & { secret_key: string };

const EMPTY_FORM: ProfileForm = {
  id: "",
  name: "",
  endpoint: "",
  access_key: "",
  secret_key: "",
  region: "us-east-1",
};

export function ProfilesScreen({ onBack, onLock }: { onBack: () => void; onLock: () => void }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [form, setForm] = useState<ProfileForm | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

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

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!form) return;
    try {
      await invoke("profile_save", { profile: form });
      setForm(null);
      setError("");
      await reload();
    } catch (err) {
      setError(String(err));
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

  const field = (key: keyof ProfileForm, placeholder: string, type = "text", full = false) => (
    <input
      className={full ? "full" : undefined}
      aria-label={placeholder}
      type={type}
      placeholder={placeholder}
      value={form?.[key] ?? ""}
      onChange={(event) => setForm({ ...(form as ProfileForm), [key]: event.currentTarget.value })}
    />
  );

  return (
    <main className="page">
      <div className="page-wide">
        <div className="page-head">
          <h1>Profiles</h1>
          <button onClick={onBack}>Back</button>
          <button onClick={onLock}>Lock</button>
          <button className="primary" onClick={() => setForm(EMPTY_FORM)}>Add profile</button>
        </div>
        {notice && <p className="notice" role="status">{notice}</p>}
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
                  <button onClick={() => setForm({ ...profile, secret_key: "" })}>Edit</button>
                  <button onClick={() => test(profile.id)}>Test</button>
                  <button onClick={() => duplicate(profile.id)}>Duplicate</button>
                  <button className="danger" onClick={() => remove(profile.id)}>Delete</button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {form && (
          <form className="form" onSubmit={save}>
            {field("name", "Name")}
            {field("region", "Region")}
            {field("endpoint", "Endpoint URL", "text", true)}
            {field("access_key", "Access key")}
            {field("secret_key", form.id ? "Secret key (blank keeps current)" : "Secret key", "password")}
            <div className="form-actions">
              <button type="button" onClick={() => setForm(null)}>Cancel</button>
              <button type="submit" className="primary">Save</button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
