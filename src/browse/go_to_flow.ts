// "Go to path": parse what the user typed, navigate through the loader, and report a readable
// error instead of leaving the panel half-moved. The footer error of the panel is not used here:
// the path field shows the message under itself.

import { homeDir } from "./browse_api";
import { useBrowseStore, type Side } from "./browse_store";
import { pushRecent, memory, updateMemory, type PanelKind } from "./location_memory";
import { sameSource } from "./navigation";
import { openLocation, openPath } from "./panel_loader";
import { parseLocation } from "./parse_location";

let knownHome = "";

async function homeDirectory(): Promise<string> {
  if (!knownHome) {
    try {
      knownHome = await homeDir();
    } catch {
      return ""; // `~` then reports that the home directory is not known
    }
  }
  return knownHome;
}

const kindOf = (side: Side): PanelKind => (useBrowseStore.getState()[side].source?.kind === "bucket" ? "server" : "local");

/** Recent locations offered under the path field of `side`: the panel kind's list, newest first. */
export const recentsFor = (side: Side): string[] => memory().recents[kindOf(side)];

function rememberRecent(side: Side): void {
  const { source, path } = useBrowseStore.getState()[side];
  const kind = kindOf(side);
  const entry = source?.kind === "bucket" ? `s3://${source.bucket}/${path}` : path;
  updateMemory((before) => ({ ...before, recents: { ...before.recents, [kind]: pushRecent(before.recents[kind], entry) } }));
}

/** Go to what the user typed. Resolves to "" on success, otherwise to the message to show; on failure the old location stays. */
export async function goToLocation(side: Side, input: string): Promise<string> {
  const home = await homeDirectory();
  const state = useBrowseStore.getState();
  const before = state[side];
  const parsed = parseLocation(input, { source: before.source, path: before.path, home, buckets: state.buckets, hasProfile: state.profileId !== null });
  if (!parsed.ok) return parsed.error;

  const { target, switched } = parsed;
  const keepsSource = sameSource(before.source, target.source);
  await (keepsSource ? openPath(side, target.path) : openLocation(side, target.source, target.path));

  const { error } = useBrowseStore.getState()[side];
  if (error) {
    // The loader put the error in the footer; move it under the field and put the old location back.
    if (keepsSource) useBrowseStore.getState().setError(side, "");
    else useBrowseStore.setState({ [side]: { ...before, loading: false } } as Pick<ReturnType<typeof useBrowseStore.getState>, Side>);
    return error;
  }
  rememberRecent(side);
  if (switched) useBrowseStore.getState().setNotice(side, `Switched to the ${target.source.kind === "local" ? "Local" : "Server"} panel`);
  return "";
}
