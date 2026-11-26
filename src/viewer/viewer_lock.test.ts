import { beforeEach, describe, expect, it } from "vitest";
import { useViewerStore, keepUnsavedForLock, type ViewerSession } from "./viewer_store";

function open(change: Partial<ViewerSession> = {}): ViewerSession {
  return {
    side: "left", profileId: "p1", name: "notes.txt", kind: "text", mode: "edit",
    source: { kind: "local", path: "/home/me/notes.txt" }, stamp: "1:1", bom: false, lineEnding: "\n",
    savedText: "saved", text: "saved", view: "text", delimiter: ",", headerRow: true, wrap: false,
    saving: false, guard: null, closeAfterSave: false, error: "", ...change,
  };
}
const session = () => useViewerStore.getState().session;
beforeEach(() => useViewerStore.setState({ session: null }));

describe("lock and the viewer", () => {
  it("keeps a session with unsaved edits, text intact", () => {
    useViewerStore.setState({ session: open({ text: "edited but not saved" }) });
    keepUnsavedForLock();
    expect(session()?.text).toBe("edited but not saved");
    expect(session()?.savedText).toBe("saved");
  });

  it("drops a clean session: nothing to lose, nothing stays in memory", () => {
    useViewerStore.setState({ session: open() });
    keepUnsavedForLock();
    expect(session()).toBeNull();
  });

  it("clears transient state so it reopens as a plain editor, not mid-save or mid-question", () => {
    useViewerStore.setState({ session: open({ text: "x", saving: true, guard: "conflict", closeAfterSave: true, error: "boom" }) });
    keepUnsavedForLock();
    expect(session()).toMatchObject({ saving: false, guard: null, closeAfterSave: false, error: "" });
  });

  it("does nothing when no viewer is open", () => {
    keepUnsavedForLock();
    expect(session()).toBeNull();
  });
});
