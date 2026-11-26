// Reload a panel's listing (reusing openPath) and keep the cursor row, or focus `focusName`.

import { useBrowseStore, type Side } from "../browse/browse_store";
import { openPath } from "../browse/panel_loader";

export async function refreshPanel(side: Side, focusName?: string): Promise<void> {
  const { path, cursor } = useBrowseStore.getState()[side];
  await openPath(side, path, focusName);
  if (focusName === undefined) useBrowseStore.getState().setCursor(side, cursor);
}
