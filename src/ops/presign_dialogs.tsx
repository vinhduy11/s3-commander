import { useState } from "react";
import { formatDate } from "../browse/navigation";
import { Buttons, Modal } from "./modal";
import { cancelDialog } from "./ops_flow";
import type { Dialog } from "./ops_store";
import { confirmPresign, copyPresigned, savePresignedUrls, submitPresignOptions } from "./presign_flow";
import { DEFAULT_EXPIRY_SECS, EXPIRY_PRESETS, EXPIRY_UNITS, expiryChoice, joinUrls, type ExpiryUnit } from "./presign_logic";

type Of<Kind extends Dialog["kind"]> = Extract<Dialog, { kind: Kind }>;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function PresignOptionsDialog({ dialog }: { dialog: Of<"presign-options"> }) {
  const [choice, setChoice] = useState(String(DEFAULT_EXPIRY_SECS));
  const [customText, setCustomText] = useState("");
  const [unit, setUnit] = useState<ExpiryUnit>("hours");
  const [filename, setFilename] = useState("");
  const [error, setError] = useState("");
  const singleFile = dialog.items.length === 1 && !dialog.items[0].is_dir;

  function submit() {
    const expiry = expiryChoice(customText, unit, choice);
    if ("error" in expiry) return setError(expiry.error);
    void submitPresignOptions(expiry.secs, singleFile ? filename : "");
  }

  return (
    <Modal title={singleFile ? "Presigned URL" : "Presigned URLs"} onCancel={cancelDialog} onConfirm={submit}>
      <p>
        Create a link to read {singleFile ? "this file" : dialog.hasFolder ? "the selected files and folders" : `${dialog.items.length} files`} without signing in, for a limited time.
      </p>
      <div className="field-label" id="presign-expiry-label">Expires after</div>
      <div className="segmented" role="radiogroup" aria-labelledby="presign-expiry-label">
        {[...EXPIRY_PRESETS.map((preset) => ({ label: preset.label, value: String(preset.secs) })), { label: "Custom", value: "custom" }].map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={choice === option.value}
            onClick={() => {
              setChoice(option.value);
              setError("");
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
      {choice === "custom" && (
        <div className="custom-expiry">
          <input aria-label="Custom expiry value" inputMode="numeric" value={customText} spellCheck={false} onChange={(event) => setCustomText(event.currentTarget.value)} />
          <select aria-label="Custom expiry unit" value={unit} onChange={(event) => setUnit(event.currentTarget.value as ExpiryUnit)}>
            {EXPIRY_UNITS.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </div>
      )}
      {singleFile && (
        <>
          <div className="field-label">Download file name (optional)</div>
          <input aria-label="Download file name" value={filename} spellCheck={false} placeholder="Save the file under this name" onChange={(event) => setFilename(event.currentTarget.value)} />
        </>
      )}
      {error && <div className="alert" role="alert">{error}</div>}
      <div className="caution">The link uses the profile endpoint, so it only works where that endpoint can be reached. Anyone who has the link can read the object until it expires.</div>
      <Buttons>
        <button type="button" onClick={cancelDialog}>Cancel</button>
        <button type="button" data-autofocus className="primary" onClick={submit}>Generate</button>
      </Buttons>
    </Modal>
  );
}

export function PresignConfirmDialog({ dialog }: { dialog: Of<"presign-confirm"> }) {
  const generated = dialog.capped ? dialog.cap : dialog.count;
  return (
    <Modal title="Presign folder contents" onCancel={cancelDialog} onConfirm={() => void confirmPresign()}>
      <p>The selection covers <strong>{plural(dialog.count, "object")}</strong>, one URL each.</p>
      {dialog.capped && <div className="alert">The limit is {dialog.cap} URLs per request: only the first {dialog.cap} objects will get a URL.</div>}
      <Buttons>
        <button type="button" onClick={cancelDialog}>Cancel</button>
        <button type="button" data-autofocus className="primary" onClick={() => void confirmPresign()}>Generate {plural(generated, "URL")}</button>
      </Buttons>
    </Modal>
  );
}

export function PresignResultDialog({ dialog }: { dialog: Of<"presign-result"> }) {
  const { items } = dialog;
  const many = items.length > 1;
  return (
    <Modal title={many ? "Presigned URLs" : "Presigned URL"} onCancel={cancelDialog} onConfirm={cancelDialog}>
      {dialog.capped && <div className="alert">Showing only the first {items.length} of {dialog.total} objects.</div>}
      <ul className="url-list" aria-label="Presigned URLs">
        {items.map((item) => (
          <li key={item.key}>
            <div className="url-head">
              <span className="mono url-name">{item.name}</span>
              {item.expires_at !== null && <span className="muted">Expires {formatDate(item.expires_at)}</span>}
              {item.url && <button type="button" data-autofocus={!many || undefined} onClick={() => void copyPresigned(item.url!)}>Copy</button>}
            </div>
            {item.url ? <div className="mono url-text">{item.url}</div> : <div className="alert-text">{item.error}</div>}
          </li>
        ))}
      </ul>
      <div className="caution">Keep these links private: anyone who has a URL can read the object until it expires. A URL uses the profile endpoint, so it must be reachable from where it is opened.</div>
      {many && <div className="muted">Saving writes live signed URLs to a text file. Delete it when you are done.</div>}
      <Buttons>
        {many && <button type="button" onClick={() => void savePresignedUrls()}>Save as text file</button>}
        {many && <button type="button" data-autofocus onClick={() => void copyPresigned(joinUrls(items), `Copied ${plural(items.filter((item) => item.url).length, "URL")}`)}>Copy all</button>}
        <button type="button" className={many ? undefined : "primary"} onClick={cancelDialog}>Close</button>
      </Buttons>
    </Modal>
  );
}
