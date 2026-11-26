import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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

  const field = (key: keyof ProfileForm, placeholder: string, type = "text") => (
    <input
      type={type}
      placeholder={placeholder}
      value={form?.[key] ?? ""}
      onChange={(event) => setForm({ ...(form as ProfileForm), [key]: event.currentTarget.value })}
    />
  );

  return (
    <main className="container">
      <h1>Profiles</h1>
      <button onClick={onBack}>Back</button> <button onClick={onLock}>Lock</button>{" "}
      <button onClick={() => setForm(EMPTY_FORM)}>Add profile</button>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      <ul>
        {profiles.map((profile) => (
          <li key={profile.id}>
            {profile.name} - {profile.endpoint} ({profile.access_key}, {profile.region}){" "}
            <button onClick={() => setForm({ ...profile, secret_key: "" })}>Edit</button>{" "}
            <button onClick={() => test(profile.id)}>Test</button>{" "}
            <button onClick={() => duplicate(profile.id)}>Duplicate</button>{" "}
            <button onClick={() => remove(profile.id)}>Delete</button>
          </li>
        ))}
      </ul>
      {form && (
        <form onSubmit={save}>
          {field("name", "Name")}
          {field("endpoint", "Endpoint URL")}
          {field("access_key", "Access key")}
          {field("secret_key", form.id ? "Secret key (blank keeps current)" : "Secret key", "password")}
          {field("region", "Region")}
          <button type="submit">Save</button> <button type="button" onClick={() => setForm(null)}>Cancel</button>
        </form>
      )}
    </main>
  );
}
