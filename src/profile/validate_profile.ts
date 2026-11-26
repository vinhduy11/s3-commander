// Mirror of src-tauri/src/profile_rules.rs for instant inline feedback. Rust stays authoritative;
// both sides are checked against src/profile/validation_cases.json. Messages never contain the
// values checked, so the secret key cannot leak through them.
export type ProfileFields = { name: string; endpoint: string; access_key: string; secret_key: string; region: string };
export type FieldId = keyof ProfileFields;
export type FieldErrors = Partial<Record<FieldId, string>>;
export type Validation = { errors: FieldErrors; clean: ProfileFields; warnings: { endpoint?: string } };

export const DEFAULT_REGION = "us-east-1";
export const HTTP_WARNING = "http sends the keys unencrypted. Use https unless this is a trusted local network.";
const NAME_MAX = 64;
const REGION_RE = /^[a-z0-9-]{1,32}$/;

// Returns the normalized endpoint, or the error message.
function checkEndpoint(raw: string): { value: string } | { error: string } {
  if (raw === "") return { error: "Endpoint URL is required." };
  if (/[\s\p{Cc}]/u.test(raw)) return { error: "Endpoint must not contain spaces." };
  const lower = raw.toLowerCase();
  if (!lower.startsWith("http://") && !lower.startsWith("https://")) return { error: "Endpoint must start with http:// or https://." };
  if (/[?#]/.test(raw)) return { error: "Endpoint must not contain a query string or fragment." };
  const authority = raw.slice(raw.indexOf("//") + 2).split("/")[0];
  if (authority.includes("@")) return { error: "Endpoint must not contain a user name or password." };
  const badPort = { error: "Port must be between 1 and 65535." };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    const port = /:(\d+)$/.exec(authority);
    return port && (Number(port[1]) < 1 || Number(port[1]) > 65535) ? badPort : { error: "Enter a valid URL, for example http://localhost:9000." };
  }
  if (url.hostname === "") return { error: "Enter a valid URL, for example http://localhost:9000." };
  if (url.port === "0") return badPort;
  if (url.pathname !== "/") return { error: "Endpoint must be the server address only, without a path." };
  return { value: url.href.replace(/\/$/, "") };
}

export function validateProfile(input: ProfileFields, others: string[], isNew: boolean): Validation {
  const errors: FieldErrors = {};
  const clean: ProfileFields = { ...input, name: input.name.trim(), access_key: input.access_key.trim(), region: input.region.trim() || DEFAULT_REGION };
  const warnings: Validation["warnings"] = {};

  if (clean.name === "") errors.name = "Name is required.";
  else if ([...clean.name].length > NAME_MAX) errors.name = `Name must be ${NAME_MAX} characters or fewer.`;
  else if (others.some((other) => other.trim().toLowerCase() === clean.name.toLowerCase())) errors.name = "A profile with this name already exists.";

  const endpoint = checkEndpoint(input.endpoint.trim());
  if ("error" in endpoint) {
    errors.endpoint = endpoint.error;
    clean.endpoint = input.endpoint.trim();
  } else {
    clean.endpoint = endpoint.value;
    if (endpoint.value.startsWith("http://")) warnings.endpoint = HTTP_WARNING;
  }

  if (clean.access_key === "") errors.access_key = "Access key is required.";
  else if (/[\s\p{Cc}]/u.test(clean.access_key)) errors.access_key = "Access key must not contain spaces or control characters.";

  if (input.secret_key === "") {
    if (isNew) errors.secret_key = "Secret key is required.";
  } else if (/\p{Cc}/u.test(input.secret_key)) errors.secret_key = "Secret key must not contain control characters or line breaks.";

  if (!REGION_RE.test(clean.region)) errors.region = "Region must be 1 to 32 characters: lowercase letters, digits and hyphens.";

  return { errors, clean, warnings };
}
