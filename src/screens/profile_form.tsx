import { useEffect, useState } from "react";
import { validateProfile, type FieldErrors, type FieldId, type ProfileFields } from "../profile/validate_profile";

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

export function ProfileForm({ initial, others, serverErrors, onSubmit, onCancel }: Props) {
  const [values, setValues] = useState(initial);
  const [touched, setTouched] = useState<Partial<Record<FieldId, boolean>>>({});
  const [server, setServer] = useState<FieldErrors>(serverErrors ?? {});
  useEffect(() => setServer(serverErrors ?? {}), [serverErrors]);

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
      <div className="form-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary" disabled={blocked}>Save</button>
      </div>
    </form>
  );
}
