import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { KeyIcon } from "../icons";

export function MasterKeyScreen({ exists, onDone }: { exists: boolean; onDone: () => void }) {
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
    <main className="center">
      <div className="card">
        <div className="brand">
          <span className="brand-mark"><KeyIcon /></span>
          <div>
            <h1>{exists ? "Unlock" : "Create vault"}</h1>
            <p className="muted">{exists ? "Enter your master key to open S3 Commander." : "Choose a master key that protects your profile secrets."}</p>
          </div>
        </div>
      <form className="stack" onSubmit={submit}>
        <input
          type="password"
          autoFocus
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
        <button type="submit" className="primary">{exists ? "Unlock" : "Create"}</button>
      </form>
      {error && <p className="alert" role="alert">{error}</p>}
      </div>
    </main>
  );
}
