// Pure helpers for the presigned URL dialogs: expiry choices and the text of a URL list.

import type { PresignedItem } from "./ops_api";

/** SigV4 allows at most 7 days. Mirrors `MAX_EXPIRES_SECS` in presign.rs, which enforces it. */
export const MAX_EXPIRY_SECS = 604800;
export const DEFAULT_EXPIRY_SECS = 3600;
export const EXPIRY_PRESETS = [
  { label: "15 minutes", secs: 900 },
  { label: "1 hour", secs: 3600 },
  { label: "1 day", secs: 86400 },
  { label: "7 days", secs: 604800 },
] as const;

export type ExpiryUnit = "seconds" | "minutes" | "hours" | "days";
export const EXPIRY_UNITS: ExpiryUnit[] = ["seconds", "minutes", "hours", "days"];
const UNIT_SECS: Record<ExpiryUnit, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };

export type ExpiryResult = { secs: number } | { error: string };

export function parseExpiry(text: string, unit: ExpiryUnit): ExpiryResult {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) return { error: "Enter a whole number of at least 1." };
  const secs = Number(trimmed) * UNIT_SECS[unit];
  return secs > MAX_EXPIRY_SECS ? { error: "The longest expiry is 7 days." } : { secs };
}

/** The expiry the form means: a preset (its seconds as text) or the custom value and unit. */
export function expiryChoice(customText: string, unit: ExpiryUnit, choice: string): ExpiryResult {
  return choice === "custom" ? parseExpiry(customText, unit) : { secs: Number(choice) };
}

/** One URL per line; items that failed have no URL and are skipped. */
export const joinUrls = (items: PresignedItem[]): string =>
  items.flatMap((item) => (item.url ? [item.url] : [])).join("\n");
