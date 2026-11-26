import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type VaultStatus = { exists: boolean; unlocked: boolean };
type Profile = {
  id: string;
  name: string;
  endpoint: string;
  access_key: string;
  region: string;
};
type ProfileForm = Profile & { secret_key: string };

const EMPTY_FORM: ProfileForm = {
  id: "",
  name: "",
  endpoint: "",
  access_key: "",
  secret_key: "",
  region: "us-east-1",
};

function MasterKeyScreen({ exists, onDone }: { exists: boolean; onDone: () => void }) {
  const [masterKey, setMasterKey] = useState("");
  const [confirmKey, setConfirmKey] = useState("");
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!exists && masterKey !== confirmKey) {
      setError("Master keys do not match");
      return;
    }
    try {
      await invoke(exists ? "vault_unlock" : "vault_create", { master: masterKey });
      setMasterKey("");
      setConfirmKey("");
      onDone();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <main className="container">
      <h1>{exists ? "Unlock" : "Create vault"}</h1>
      <form onSubmit={submit}>
        <input
          type="password"
          placeholder="Master key"
          value={masterKey}
          onChange={(event) => setMasterKey(event.currentTarget.value)}
        />
        {!exists && (
          <input
            type="password"
            placeholder="Confirm master key"
            value={confirmKey}
            onChange={(event) => setConfirmKey(event.currentTarget.value)}
          />
        )}
        <button type="submit">{exists ? "Unlock" : "Create"}</button>
      </form>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}

function ProfilesScreen({ onLock }: { onLock: () => void }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [form, setForm] = useState<ProfileForm | null>(null);
  const [error, setError] = useState("");

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

  async function lock() {
    await invoke("vault_lock");
    onLock();
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
      <button onClick={lock}>Lock</button> <button onClick={() => setForm(EMPTY_FORM)}>Add profile</button>
      {error && <p role="alert">{error}</p>}
      <ul>
        {profiles.map((profile) => (
          <li key={profile.id}>
            {profile.name} - {profile.endpoint} ({profile.access_key}, {profile.region}){" "}
            <button onClick={() => setForm({ ...profile, secret_key: "" })}>Edit</button>{" "}
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

function App() {
  const [status, setStatus] = useState<VaultStatus | null>(null);

  async function refreshStatus() {
    setStatus(await invoke<VaultStatus>("vault_status"));
  }

  useEffect(() => {
    refreshStatus();
  }, []);

  if (!status) return null;
  if (!status.unlocked) return <MasterKeyScreen exists={status.exists} onDone={refreshStatus} />;
  return <ProfilesScreen onLock={refreshStatus} />;
}

export default App;
