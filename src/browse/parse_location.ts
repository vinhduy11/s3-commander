// Pure parser of what the user types in a panel's path field. No I/O: the home directory, the
// bucket list and the profile state arrive through `current`, so every rule is testable.
// Local: absolute, ~, relative, file:///. Server: s3://bucket/prefix, /prefix (from the bucket
// root), relative prefix. `.` and `..` are resolved textually and never climb above the root.

import type { PanelSource } from "./browse_store";

export type LocationContext = {
  source: PanelSource | null;
  /** Local: absolute folder. Bucket: key prefix. May be "" before the first listing. */
  path: string;
  /** The user's home directory; "" when unknown. */
  home: string;
  /** Buckets of the active profile; empty without a profile. */
  buckets: string[];
  hasProfile: boolean;
};
export type LocationTarget = { source: PanelSource; path: string };
export type ParseResult = { ok: true; target: LocationTarget; switched: boolean } | { ok: false; error: string };

const LOCAL: PanelSource = { kind: "local" };
const failure = (error: string): ParseResult => ({ ok: false, error });
const CONTROL_CHARS = /[\0-\x1f\x7f]/;

/** Trim, then drop one pair of matching surrounding quotes (a path pasted from a shell or a file manager). */
function cleaned(input: string): string {
  const trimmed = input.trim();
  const quoted = trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed[trimmed.length - 1] === trimmed[0];
  return quoted ? trimmed.slice(1, -1).trim() : trimmed;
}

/** Resolve `.`, `..` and empty segments; `..` at the root stays at the root. */
function resolveSegments(parts: string[]): string[] {
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return resolved;
}

const localTarget = (parts: string[]): LocationTarget => ({ source: LOCAL, path: `/${resolveSegments(parts).join("/")}` });

function bucketTarget(bucket: string, parts: string[]): LocationTarget {
  const segments = resolveSegments(parts);
  return { source: { kind: "bucket", bucket }, path: segments.length ? `${segments.join("/")}/` : "" };
}

function decodeFileUrlPath(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw; // a stray % is part of the name
  }
}

function parseLocal(text: string, current: LocationContext): LocationTarget | string {
  if (/^file:\/\//i.test(text)) {
    const rest = text.slice("file://".length);
    return rest.startsWith("/") ? localTarget(decodeFileUrlPath(rest).split("/")) : "Use file:///absolute/path";
  }
  if (text === "~" || text.startsWith("~/")) {
    return current.home ? localTarget([...current.home.split("/"), ...text.slice(1).split("/")]) : "The home directory is not known";
  }
  if (text.startsWith("/")) return localTarget(text.split("/"));
  const base = current.source?.kind === "bucket" ? "" : current.path || current.home;
  return localTarget([...base.split("/"), ...text.split("/")]);
}

function parseServer(text: string, current: LocationContext, bucket: string): LocationTarget {
  const base = text.startsWith("/") ? [] : current.path.split("/");
  return bucketTarget(bucket, [...base, ...text.split("/")]);
}

function parseS3Url(text: string, current: LocationContext): LocationTarget | string {
  if (!current.hasProfile) return "No active profile: choose a profile before opening an s3:// location";
  const [bucket, ...rest] = text.slice("s3://".length).split("/");
  if (!bucket) return "Missing bucket name after s3://";
  if (!current.buckets.includes(bucket)) return `Bucket "${bucket}" is not in this profile's bucket list`;
  return bucketTarget(bucket, rest);
}

export function parseLocation(input: string, current: LocationContext): ParseResult {
  const text = cleaned(input);
  if (!text) return failure("Type a path");
  if (CONTROL_CHARS.test(text)) return failure("Invalid character in the path");

  const inBucket = current.source?.kind === "bucket";
  const goesLocal = /^file:\/\//i.test(text) || text === "~" || text.startsWith("~/");
  let target: LocationTarget | string;
  if (/^s3:\/\//i.test(text)) target = parseS3Url(text, current);
  else if (goesLocal || !inBucket) target = parseLocal(text, current);
  else target = parseServer(text, current, (current.source as { bucket: string }).bucket);

  if (typeof target === "string") return failure(target);
  return { ok: true, target, switched: (target.source.kind === "bucket") !== inBucket };
}
