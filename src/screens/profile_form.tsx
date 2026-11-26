import { useEffect, useState } from "react";
import { listAwsProfiles, readAwsProfile, type AwsProfileSettings } from "../profile/aws_import_api";
import { TRANSFER_DEFAULTS, TRANSFER_KEYS, validateProfile, type FieldErrors, type FieldId, type ProfileFields, type TransferKey } from "../profile/validate_profile";

export type ProfileFormValues = ProfileFields & { id: string };

type Props = {
  initial: ProfileFormValues;
  /** Names of the other profiles (without the one being edited), for the uniqueness check. */
  others: string[];
  /** Per-field errors returned by Rust on the last save; a field's error clears when it changes. */
  serverErrors?: FieldErrors;
  onSubmit: (values: ProfileFormValues) => void;
  onCancel: () => void;
};

const FIELDS: { key: FieldId; label: string; type?: string; full?: boolean }[] = [
  { key: "name", label: "Name" },
  { key: "region", label: "Region" },
  { key: "endpoint", label: "Endpoint URL", full: true },
  { key: "access_key", label: "Access key" },
  { key: "secret_key", label: "Secret key", type: "password" },
];

const TRANSFER_FIELDS: { key: TransferKey; label: string; hint: string }[] = [
  { key: "multipart_threshold", label: "Multipart threshold", hint: "Objects this size or larger upload in parts." },
  { key: "multipart_chunksize", label: "Multipart chunk size", hint: "Part size, at least 5 MB." },
  { key: "max_concurrent_requests", label: "Max concurrent requests", hint: "Parallel parts and items, 1 to 256." },
];
const STYLES = ["path", "virtual", "auto"];
// Imported key (AWS CLI name) to form field.
const IMPORT_MAP: [keyof AwsProfileSettings, FieldId][] = [
  ["endpoint_url", "endpoint"],
  ["region", "region"],
  ...TRANSFER_KEYS.map((key): [keyof AwsProfileSettings, FieldId] => [key, key]),
];

type ImportState = { names: string[] | null; message: string; notice: string };
const NO_IMPORT: ImportState = { names: null, message: "", notice: "" };

export function ProfileForm({ initial, others, serverErrors, onSubmit, onCancel }: Props) {
  const [values, setValues] = useState(initial);
  const [touched, setTouched] = useState<Partial<Record<FieldId, boolean>>>({});
  const [server, setServer] = useState<FieldErrors>(serverErrors ?? {});
  useEffect(() => setServer(serverErrors ?? {}), [serverErrors]);
  const hasTransfer = (source: Partial<Record<string, string>>) => TRANSFER_KEYS.some((key) => (source[key] ?? "") !== "");
  const [open, setOpen] = useState(() => hasTransfer(initial) || TRANSFER_KEYS.some((key) => serverErrors?.[key]));
  useEffect(() => {
    if (TRANSFER_KEYS.some((key) => serverErrors?.[key])) setOpen(true);
  }, [serverErrors]);
  const [imported, setImported] = useState<ImportState>(NO_IMPORT);

  const isNew = initial.id === "";
  const { errors, clean, warnings } = validateProfile(values, others, isNew);
  const shown = (key: FieldId) => server[key] ?? (touched[key] ? errors[key] : undefined);
  const blocked = Object.keys(errors).length > 0 || Object.keys(server).length > 0;

  function change(key: FieldId, value: string) {
    setValues({ ...values, [key]: value });
    setTouched({ ...touched, [key]: true });
    if (server[key]) setServer(({ [key]: _gone, ...rest }) => rest);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (blocked) return;
    onSubmit({ ...clean, id: values.id });
  }

  async function toggleImport() {
    if (imported.names !== null || imported.message) return setImported(NO_IMPORT);
    try {
      setImported({ names: await listAwsProfiles(), message: "", notice: "" });
    } catch (err) {
      setImported({ names: null, message: String(err), notice: "" });
    }
  }

  async function importProfile(name: string) {
    try {
      const found = await readAwsProfile(name);
      const next: Record<string, string> = {};
      for (const [from, to] of IMPORT_MAP) {
        const value = found[from]?.trim();
        if (value) next[to] = value;
      }
      setValues({ ...values, ...next });
      setTouched({ ...touched, ...Object.fromEntries(Object.keys(next).map((key) => [key, true])) });
      setServer({});
      if (hasTransfer(next)) setOpen(true);
      setImported({ names: null, message: "", notice: `Imported "${name}". Review the values, then save.` });
    } catch (err) {
      setImported({ names: imported.names, message: String(err), notice: "" });
    }
  }

  const transferError = (key: TransferKey) => {
    const message = shown(key);
    const errorId = `profile-${key}-error`;
    return {
      message,
      props: { "aria-invalid": message ? true : undefined, "aria-describedby": message ? errorId : undefined },
      node: message && <p id={errorId} className="field-error" role="alert">{message}</p>,
    };
  };
  const style = values.addressing_style ?? "";

  return (
    <form className="form" onSubmit={submit} noValidate>
      {FIELDS.map(({ key, label, type, full }) => {
        const message = shown(key);
        const errorId = `profile-${key}-error`;
        const text = key === "secret_key" && !isNew ? "Secret key (blank keeps current)" : label;
        return (
          <div key={key} className={full ? "field full" : "field"}>
            <input
              aria-label={text}
              placeholder={text}
              type={type ?? "text"}
              value={values[key]}
              aria-invalid={message ? true : undefined}
              aria-describedby={message ? errorId : undefined}
              onChange={(event) => change(key, event.currentTarget.value)}
              onBlur={() => setTouched({ ...touched, [key]: true })}
            />
            {message && <p id={errorId} className="field-error" role="alert">{message}</p>}
            {key === "endpoint" && !message && warnings.endpoint && (
              <p className="field-warning" role="status" data-testid="http-warning">{warnings.endpoint}</p>
            )}
          </div>
        );
      })}
      <div className="full transfer">
        <button type="button" className="section-toggle" aria-expanded={open} aria-controls="transfer-settings" onClick={() => setOpen(!open)}>
          <span className="chevron" aria-hidden="true">{open ? "\u25BE" : "\u25B8"}</span> Transfer settings
        </button>
        {open && (
          <div id="transfer-settings" className="transfer-grid">
            {TRANSFER_FIELDS.map(({ key, label, hint }) => {
              const err = transferError(key);
              return (
                <div key={key} className="field">
                  <label htmlFor={`profile-${key}`}>{label}</label>
                  <input
                    id={`profile-${key}`}
                    aria-label={label}
                    placeholder={TRANSFER_DEFAULTS[key]}
                    value={values[key] ?? ""}
                    {...err.props}
                    onChange={(event) => change(key, event.currentTarget.value)}
                    onBlur={() => setTouched({ ...touched, [key]: true })}
                  />
                  {err.node || <p className="field-hint">{hint}</p>}
                </div>
              );
            })}
            <div className="field">
              <label htmlFor="profile-addressing_style">Addressing style</label>
              <select
                id="profile-addressing_style"
                aria-label="Addressing style"
                value={style}
                {...transferError("addressing_style").props}
                onChange={(event) => change("addressing_style", event.currentTarget.value)}
              >
                <option value="">Default (path)</option>
                {STYLES.map((name) => <option key={name} value={name}>{name}</option>)}
                {style !== "" && !STYLES.includes(style) && <option value={style}>{style} (invalid)</option>}
              </select>
              {transferError("addressing_style").node || <p className="field-hint">path suits MinIO; virtual and auto use bucket.host.</p>}
            </div>
          </div>
        )}
      </div>
      {(imported.names !== null || imported.message || imported.notice) && (
        <div className="full import-panel">
          {imported.notice && <p className="field-hint" role="status" data-testid="aws-import-notice">{imported.notice}</p>}
          {imported.message && <p className="field-error" role="alert" data-testid="aws-import-message">{imported.message}</p>}
          {imported.names !== null && imported.names.length === 0 && <p className="field-hint">No profiles found in the AWS config file.</p>}
          {imported.names !== null && imported.names.length > 0 && (
            <>
              <p className="field-hint">Choose a profile to fill the form. Only region, endpoint and transfer settings are read, never keys.</p>
              <ul className="aws-list" data-testid="aws-profile-list">
                {imported.names.map((name) => (
                  <li key={name}><button type="button" onClick={() => importProfile(name)}>{name}</button></li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <div className="form-actions">
        <button type="button" className="import-btn" onClick={toggleImport}>Import from AWS CLI</button>
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary" disabled={blocked}>Save</button>
      </div>
    </form>
  );
}
