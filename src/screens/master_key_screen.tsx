import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { KeyIcon } from "../icons";

/** "4 s", "4 min 16 s". */
export function formatWait(seconds: number): string {
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export function MasterKeyScreen({ exists, onDone }: { exists: boolean; onDone: () => void }) {
  const [masterKey, setMasterKey] = useState("");
  const [confirmKey, setConfirmKey] = useState("");
  const [error, setError] = useState("");
  // Wall-clock end of the unlock delay Rust reported (0 = none); `now` ticks while it runs.
  const [waitUntil, setWaitUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const remaining = Math.max(0, Math.ceil((waitUntil - now) / 1000));

  async function refreshWait() {
    if (!exists) return;
    try {
      const ms = await invoke<number>("vault_unlock_wait");
      setNow(Date.now());
      setWaitUntil(Date.now() + ms);
    } catch {
      // Rust still enforces the delay on the unlock call itself.
    }
  }

  useEffect(() => void refreshWait(), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (remaining <= 0) return;
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(tick);
  }, [remaining > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (remaining > 0) return;
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
      await refreshWait();
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
        <button type="submit" className="primary" disabled={remaining > 0}>{exists ? "Unlock" : "Create"}</button>
      </form>
      {remaining > 0 && <p className="caution" role="status">Too many failed attempts. Try again in {formatWait(remaining)}.</p>}
      {error && <p className="alert" role="alert">{error}</p>}
      </div>
    </main>
  );
}
