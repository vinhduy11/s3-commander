import { describe, expect, it } from "vitest";
import { initialUpdateState, percentOf, reduceUpdate, shouldCheckAtLaunch, statusLine, type UpdateState } from "./update_logic";

const found = { version: "1.0.1", currentVersion: "1.0.0", notes: "Fixes" };
const run = (events: Parameters<typeof reduceUpdate>[1][], from: UpdateState = initialUpdateState) => events.reduce(reduceUpdate, from);

describe("update state machine", () => {
  it("starts idle", () => {
    expect(initialUpdateState.phase).toBe("idle");
  });

  it("idle -> checking -> up to date", () => {
    expect(run([{ type: "check_started" }]).phase).toBe("checking");
    expect(run([{ type: "check_started" }, { type: "check_finished", update: null }]).phase).toBe("up_to_date");
  });

  it("checking -> available keeps version, current version and notes", () => {
    const state = run([{ type: "check_started" }, { type: "check_finished", update: found }]);
    expect(state).toMatchObject({ phase: "available", version: "1.0.1", currentVersion: "1.0.0", notes: "Fixes" });
  });

  it("a manual check failure is an error with the message", () => {
    const state = run([{ type: "check_started" }, { type: "check_failed", message: "offline", silent: false }]);
    expect(state).toMatchObject({ phase: "error", error: "offline" });
  });

  it("a silent check failure goes back to idle with no message", () => {
    const state = run([{ type: "check_started" }, { type: "check_failed", message: "offline", silent: true }]);
    expect(state).toMatchObject({ phase: "idle", error: "" });
  });

  it("downloading tracks bytes from the progress events", () => {
    let state = run([{ type: "check_finished", update: found }, { type: "download_started" }]);
    expect(state.phase).toBe("downloading");
    state = run([{ type: "download_event", event: { event: "Started", data: { contentLength: 200 } } }], state);
    expect(state).toMatchObject({ downloaded: 0, total: 200 });
    state = run([{ type: "download_event", event: { event: "Progress", data: { chunkLength: 50 } } }, { type: "download_event", event: { event: "Progress", data: { chunkLength: 50 } } }], state);
    expect(state.downloaded).toBe(100);
    expect(percentOf(state)).toBe(50);
    state = run([{ type: "download_event", event: { event: "Finished" } }], state);
    expect(percentOf(state)).toBe(100);
  });

  it("an unknown content length gives no percent", () => {
    const state = run([
      { type: "check_finished", update: found },
      { type: "download_started" },
      { type: "download_event", event: { event: "Started", data: {} } },
      { type: "download_event", event: { event: "Progress", data: { chunkLength: 10 } } },
    ]);
    expect(state.total).toBeNull();
    expect(percentOf(state)).toBeNull();
  });

  it("the percent never passes 100", () => {
    const state = run([
      { type: "check_finished", update: found },
      { type: "download_started" },
      { type: "download_event", event: { event: "Started", data: { contentLength: 10 } } },
      { type: "download_event", event: { event: "Progress", data: { chunkLength: 25 } } },
    ]);
    expect(percentOf(state)).toBe(100);
  });

  it("downloading -> installed, or error when the install fails", () => {
    const downloading = run([{ type: "check_finished", update: found }, { type: "download_started" }]);
    expect(run([{ type: "installed" }], downloading).phase).toBe("installed");
    expect(run([{ type: "install_failed", message: "bad signature" }], downloading)).toMatchObject({ phase: "error", error: "bad signature", version: "1.0.1" });
  });

  it("a check does not interrupt a download or a finished install", () => {
    const downloading = run([{ type: "check_finished", update: found }, { type: "download_started" }]);
    expect(run([{ type: "check_started" }], downloading).phase).toBe("downloading");
    const installed = run([{ type: "installed" }], downloading);
    expect(run([{ type: "check_started" }], installed).phase).toBe("installed");
  });

  it("closing an error returns to available when an update is pending, else idle", () => {
    const failed = run([{ type: "check_finished", update: found }, { type: "download_started" }, { type: "install_failed", message: "x" }]);
    expect(run([{ type: "error_closed", hasPending: true }], failed).phase).toBe("available");
    expect(run([{ type: "error_closed", hasPending: false }], failed).phase).toBe("idle");
  });
});

describe("launch gating", () => {
  const on = { dev: false, enabled: true, alreadyChecked: false };
  it("checks in a release build when enabled and not done yet", () => expect(shouldCheckAtLaunch(on)).toBe(true));
  it("never in a dev build", () => expect(shouldCheckAtLaunch({ ...on, dev: true })).toBe(false));
  it("never when the setting is off", () => expect(shouldCheckAtLaunch({ ...on, enabled: false })).toBe(false));
  it("only once per launch", () => expect(shouldCheckAtLaunch({ ...on, alreadyChecked: true })).toBe(false));
});

describe("status line", () => {
  it("has a readable text per phase", () => {
    expect(statusLine(initialUpdateState)).toBe("");
    expect(statusLine({ ...initialUpdateState, phase: "checking" })).toBe("Checking for updates...");
    expect(statusLine({ ...initialUpdateState, phase: "up_to_date" })).toBe("You are up to date.");
    expect(statusLine({ ...initialUpdateState, phase: "available", version: "1.0.1" })).toBe("Update 1.0.1 available.");
    expect(statusLine({ ...initialUpdateState, phase: "downloading", version: "1.0.1" })).toBe("Downloading update 1.0.1...");
    expect(statusLine({ ...initialUpdateState, phase: "installed", version: "1.0.1" })).toBe("Update 1.0.1 is installed. Restart to use it.");
    expect(statusLine({ ...initialUpdateState, phase: "error", error: "offline" })).toBe("offline");
  });
});
