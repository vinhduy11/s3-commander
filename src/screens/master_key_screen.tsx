import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

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
