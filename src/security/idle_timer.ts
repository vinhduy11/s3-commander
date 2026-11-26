// Pure idle timer for auto-lock. `activity()` only records the time (cheap enough for every
// pointer move); a single timeout checks the deadline and re-arms for the remainder.
// It fires once; after that it ignores activity (the owner makes a new one after unlock).

export type IdleTimer = {
  activity: () => void;
  /** 0 = Never. A change counts as activity and restarts the countdown. */
  setMinutes: (minutes: number) => void;
  stop: () => void;
};

export function createIdleTimer(options: { minutes: number; onIdle: () => void }): IdleTimer {
  let ms = options.minutes * 60_000;
  let last = Date.now();
  let handle: ReturnType<typeof setTimeout> | null = null;
  let done = false;

  const clear = () => {
    if (handle !== null) clearTimeout(handle);
    handle = null;
  };
  const arm = (delay: number) => {
    clear();
    if (!done && ms > 0) handle = setTimeout(check, delay);
  };
  function check() {
    handle = null;
    const left = ms - (Date.now() - last);
    if (left > 0) return arm(left);
    done = true;
    options.onIdle();
  }

  arm(ms);
  return {
    activity: () => {
      last = Date.now();
    },
    setMinutes: (minutes) => {
      ms = minutes * 60_000;
      last = Date.now();
      arm(ms);
    },
    stop: () => {
      done = true;
      clear();
    },
  };
}
