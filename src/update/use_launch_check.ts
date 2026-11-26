// One quiet update check per launch, a few seconds after the vault opens (never on the master key screen).

import { useEffect } from "react";
import { useUpdateStore } from "./update_store";

export const LAUNCH_CHECK_DELAY_MS = 5000;

export function useLaunchUpdateCheck(unlocked: boolean, options?: { dev?: boolean }): void {
  useEffect(() => {
    if (!unlocked) return;
    const timer = setTimeout(() => void useUpdateStore.getState().checkAtLaunch(options), LAUNCH_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
    // `options` is only a test hook, so it is not a dependency.
  }, [unlocked]);
}
