// Mirror of src-tauri/src/profile_rules.rs for instant inline feedback. Rust stays authoritative;
// both sides are checked against src/profile/validation_cases.json. Messages never contain the
// values checked, so the secret key cannot leak through them.
export const TRANSFER_KEYS = ["multipart_threshold", "multipart_chunksize", "max_concurrent_requests", "addressing_style"] as const;
export type TransferKey = (typeof TRANSFER_KEYS)[number];
export type TransferFields = Record<TransferKey, string>;
// The four transfer settings are optional strings; empty = not set (the AWS CLI default applies).
export type ProfileFields = { name: string; endpoint: string; access_key: string; secret_key: string; region: string } & Partial<TransferFields>;
export type FieldId = keyof ProfileFields;
export type FieldErrors = Partial<Record<FieldId, string>>;
export type Validation = { errors: FieldErrors; clean: ProfileFields; warnings: { endpoint?: string } };

export const DEFAULT_REGION = "us-east-1";
export const HTTP_WARNING = "http sends the keys unencrypted. Use https unless this is a trusted local network.";
const NAME_MAX = 64;
const REGION_RE = /^[a-z0-9-]{1,32}$/;
export const TRANSFER_DEFAULTS = { multipart_threshold: "8MB", multipart_chunksize: "8MB", max_concurrent_requests: "10", addressing_style: "path" };
const MIN_CHUNKSIZE = 5 * 1024 ** 2;
const DEFAULT_SIZE = 8 * 1024 ** 2;
const BAD_SIZE = "Enter a size such as 8MB, 100MB or 1GB, or a number of bytes.";
const SUFFIX_SHIFT: Record<string, number> = { KB: 1, MB: 2, GB: 3, TB: 4 };

// AWS-CLI-style size: digits, then optionally one space and KB/MB/GB/TB (1024-based, any case); no decimals.
// Returns the canonical text and the byte count, or null. Mirrors transfer_settings.rs (u64 limit included).
export function parseSize(text: string): { text: string; bytes: bigint } | null {
  const m = /^(\d+)(?: ?(KB|MB|GB|TB))?$/i.exec(text.trim());
  if (!m) return null;
  const suffix = m[2]?.toUpperCase();
  const number = BigInt(m[1]);
  const bytes = suffix ? number << BigInt(10 * SUFFIX_SHIFT[suffix]) : number;
  if (bytes >= 1n << 64n) return null;
  return { text: `${number}${suffix ?? ""}`, bytes };
}

function checkTransfer(input: ProfileFields, clean: ProfileFields, errors: FieldErrors) {
  const sizes: Partial<Record<"multipart_threshold" | "multipart_chunksize", bigint>> = {};
  for (const key of ["multipart_threshold", "multipart_chunksize"] as const) {
    const raw = (input[key] ?? "").trim();
    clean[key] = raw;
    if (raw === "") continue;
    const parsed = parseSize(raw);
    if (!parsed) {
      errors[key] = BAD_SIZE;
      continue;
    }
    clean[key] = parsed.text;
    if (key === "multipart_chunksize" && parsed.bytes < BigInt(MIN_CHUNKSIZE)) errors[key] = "Chunk size must be at least 5 MB (the S3 minimum part size).";
    else sizes[key] = parsed.bytes;
  }
  if (!errors.multipart_threshold && !errors.multipart_chunksize) {
    const threshold = sizes.multipart_threshold ?? BigInt(DEFAULT_SIZE);
    const chunksize = sizes.multipart_chunksize ?? BigInt(DEFAULT_SIZE);
    if (threshold < chunksize) {
      if (sizes.multipart_threshold !== undefined) errors.multipart_threshold = "Threshold must not be smaller than the chunk size.";
      else errors.multipart_chunksize = "Chunk size must not be larger than the threshold (default 8 MB).";
    }
  }
  const concurrency = (input.max_concurrent_requests ?? "").trim();
  clean.max_concurrent_requests = concurrency;
  if (concurrency !== "") {
    const n = /^\d+$/.test(concurrency) ? Number(concurrency) : NaN;
    if (n >= 1 && n <= 256) clean.max_concurrent_requests = String(n);
    else errors.max_concurrent_requests = "Max concurrent requests must be a whole number between 1 and 256.";
  }
  const style = (input.addressing_style ?? "").trim().toLowerCase();
  clean.addressing_style = style;
  if (style !== "" && !["path", "virtual", "auto"].includes(style)) errors.addressing_style = "Addressing style must be path, virtual or auto.";
}

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

  checkTransfer(input, clean, errors);

  return { errors, clean, warnings };
}
