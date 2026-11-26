import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPanel, initialBrowseState, useBrowseStore, type PanelEntry } from "../browse/browse_store";
import * as panelLoader from "../browse/panel_loader";
import { useOpsStore } from "../ops/ops_store";
import * as api from "./viewer_api";
import {
  confirmInvalidJsonSave,
  discardAndClose,
  dismissGuard,
  isDirty,
  overwriteSave,
  requestClose,
  saveViewer,
  setViewerText,
  startSaveAsCopy,
  startViewer,
  submitCopyName,
  switchToEdit,
} from "./viewer_flow";
import { useViewerStore } from "./viewer_store";

vi.mock("./viewer_api");
vi.mock("../browse/panel_loader");

const file = (name: string, size = 10): PanelEntry => ({ name, isDir: false, size, modified: 1 });
const dir = (name: string): PanelEntry => ({ name, isDir: true, size: 0, modified: null });
const session = () => useViewerStore.getState().session;
const dialog = () => useOpsStore.getState().dialog;
const browse = () => useBrowseStore.getState();

const localOpen = (text = "hello\n", extra: Partial<api.LocalTextOpen> = {}): api.LocalTextOpen => ({ text, bom: false, size: text.length, stamp: "10:1", ...extra });
const s3Open = (text = "a,b\r\n1,2\r\n", extra: Partial<api.S3TextOpen> = {}): api.S3TextOpen => ({
  text, bom: true, size: text.length, etag: '"e1"', content_type: "text/csv", metadata: { owner: "team-a" }, ...extra,
});

// left: local /home/me rows: 0 "..", 1 notes.txt, 2 data.json, 3 sub; right: bucket alpha in/ rows: 0 "..", 1 t.csv, 2 sub
function setup() {
  useBrowseStore.setState({
    ...initialBrowseState(),
    profileId: "p1",
    active: "left",
    left: { ...emptyPanel(), source: { kind: "local" }, path: "/home/me", entries: [file("notes.txt"), file("data.json"), dir("sub")], cursor: 1 },
    right: { ...emptyPanel(), source: { kind: "bucket", bucket: "alpha" }, path: "in/", entries: [file("t.csv"), dir("sub")], cursor: 1 },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  setup();
  useOpsStore.getState().setDialog(null);
  useViewerStore.setState({ session: null });
  vi.mocked(panelLoader.openPath).mockResolvedValue(undefined);
});

describe("opening", () => {
  it("F3 opens the cursor file read-only: the local path is panel path + name", async () => {
    vi.mocked(api.localTextOpen).mockResolvedValue(localOpen("x"));
    await startViewer("view", "left");
    expect(api.localTextOpen).toHaveBeenCalledWith("/home/me/notes.txt");
    expect(session()).toMatchObject({ mode: "view", kind: "text", name: "notes.txt", text: "x", savedText: "x", side: "left" });
    expect(dialog()).toBeNull();
  });

  it("F4 opens it editable, and a .json name gets the JSON flavour", async () => {
    browse().setCursor("left", 2);
    vi.mocked(api.localTextOpen).mockResolvedValue(localOpen("{}"));
    await startViewer("edit", "left");
    expect(session()).toMatchObject({ mode: "edit", kind: "json", name: "data.json" });
  });

  it("opens a server object with profile, bucket and key, and remembers ETag, Content-Type and metadata", async () => {
    vi.mocked(api.s3TextOpen).mockResolvedValue(s3Open());
    await startViewer("edit", "right");
    expect(api.s3TextOpen).toHaveBeenCalledWith("p1", "alpha", "in/t.csv");
    expect(session()).toMatchObject({
      kind: "csv", bom: true, lineEnding: "\r\n", delimiter: ",",
      source: { kind: "bucket", bucket: "alpha", key: "in/t.csv", etag: '"e1"', contentType: "text/csv", metadata: { owner: "team-a" } },
    });
  });

  it("detects a semicolon delimiter and a CRLF file", async () => {
    vi.mocked(api.s3TextOpen).mockResolvedValue(s3Open("a;b\r\n1;2\r\n"));
    await startViewer("view", "right");
    expect(session()).toMatchObject({ delimiter: ";", lineEnding: "\r\n", view: "text" });
  });

  it("acts on the cursor row even when others are marked", async () => {
    browse().toggleMark("left", "data.json");
    vi.mocked(api.localTextOpen).mockResolvedValue(localOpen());
    await startViewer("view", "left");
    expect(api.localTextOpen).toHaveBeenCalledWith("/home/me/notes.txt");
  });

  it("refuses a folder, the .. row and an empty panel with a message and no call", async () => {
    browse().setCursor("left", 3);
    await startViewer("view", "left");
    expect(dialog()).toMatchObject({ kind: "result", lines: ["Select a file to open."] });
    useOpsStore.getState().setDialog(null);
    browse().setCursor("left", 0);
    await startViewer("edit", "left");
    expect(dialog()).toMatchObject({ kind: "result" });
    expect(api.localTextOpen).not.toHaveBeenCalled();
    expect(session()).toBeNull();
  });

  it("refuses a file above 5 MiB before asking the backend, and says how to open it elsewhere", async () => {
    useBrowseStore.setState({ left: { ...browse().left, entries: [file("notes.txt", 5 * 1024 * 1024 + 1), file("data.json"), dir("sub")], cursor: 1 } });
    await startViewer("view", "left");
    expect(api.localTextOpen).not.toHaveBeenCalled();
    expect(dialog()).toMatchObject({ kind: "result", title: "Cannot open" });
    expect((dialog() as { lines: string[] }).lines[0]).toContain("5 MiB");
  });

  it("shows the backend's message for a binary or non-UTF-8 file and opens nothing", async () => {
    vi.mocked(api.localTextOpen).mockRejectedValue("This is not a text file (it contains binary data).");
    await startViewer("view", "left");
    expect(dialog()).toMatchObject({ kind: "result", title: "Cannot open", lines: ["This is not a text file (it contains binary data)."] });
    expect(session()).toBeNull();
  });

  it("does nothing while another dialog is open or a viewer is already open", async () => {
    useOpsStore.getState().setDialog({ kind: "busy", label: "x" });
    await startViewer("view", "left");
    expect(api.localTextOpen).not.toHaveBeenCalled();
    useOpsStore.getState().setDialog(null);
    vi.mocked(api.localTextOpen).mockResolvedValue(localOpen());
    await startViewer("view", "left");
    await startViewer("view", "left");
    expect(api.localTextOpen).toHaveBeenCalledTimes(1);
  });

  it("a server panel without a profile cannot open", async () => {
    useBrowseStore.setState({ profileId: null });
    await startViewer("view", "right");
    expect(api.s3TextOpen).not.toHaveBeenCalled();
    expect(dialog()).toMatchObject({ kind: "result" });
  });
});

describe("dirty state and the close guard", () => {
  beforeEach(async () => {
    vi.mocked(api.localTextOpen).mockResolvedValue(localOpen("one"));
    await startViewer("edit", "left");
  });

  it("is dirty only while the text differs from the saved text", () => {
    expect(isDirty(session()!)).toBe(false);
    setViewerText("two");
    expect(isDirty(session()!)).toBe(true);
    setViewerText("one");
    expect(isDirty(session()!)).toBe(false);
  });

  it("closes at once when clean", () => {
    requestClose();
    expect(session()).toBeNull();
  });

  it("asks first when dirty; Cancel keeps the text, Discard drops it", () => {
    setViewerText("two");
    requestClose();
    expect(session()).toMatchObject({ guard: "close", text: "two" });
    dismissGuard();
    expect(session()).toMatchObject({ guard: null, text: "two" });
    requestClose();
    discardAndClose();
    expect(session()).toBeNull();
  });

  it("Save from the guard saves and then closes", async () => {
    vi.mocked(api.localTextSave).mockResolvedValue({ status: "saved", stamp: "9:9" });
    setViewerText("two");
    requestClose();
    await saveViewer();
    expect(api.localTextSave).toHaveBeenCalledWith("/home/me/notes.txt", "two", false, "10:1");
    expect(session()).toBeNull();
  });

  it("Save from the guard keeps the viewer open when the save fails", async () => {
    vi.mocked(api.localTextSave).mockRejectedValue("permission denied");
    setViewerText("two");
    requestClose();
    await saveViewer();
    expect(session()).toMatchObject({ error: "permission denied", text: "two", guard: null });
  });

});

describe("saving a local file", () => {
  beforeEach(async () => {
    vi.mocked(api.localTextOpen).mockResolvedValue(localOpen("one", { bom: true }));
    await startViewer("edit", "left");
    setViewerText("two");
  });

  it("sends the text, the BOM flag and the stamp, marks it saved and refreshes the panel", async () => {
    vi.mocked(api.localTextSave).mockResolvedValue({ status: "saved", stamp: "3:5" });
    await saveViewer();
    expect(api.localTextSave).toHaveBeenCalledWith("/home/me/notes.txt", "two", true, "10:1");
    expect(session()).toMatchObject({ savedText: "two", stamp: "3:5" });
    expect(isDirty(session()!)).toBe(false);
    expect(panelLoader.openPath).toHaveBeenCalledWith("left", "/home/me");
  });

  it("a changed-on-disk file asks Overwrite, Save as copy or Cancel and writes nothing", async () => {
    vi.mocked(api.localTextSave).mockResolvedValue({ status: "changed" });
    await saveViewer();
    expect(session()).toMatchObject({ guard: "conflict", savedText: "one" });
    expect(isDirty(session()!)).toBe(true);
    dismissGuard();
    expect(session()).toMatchObject({ guard: null, text: "two" });
  });

  it("Overwrite saves again without a stamp", async () => {
    vi.mocked(api.localTextSave).mockResolvedValueOnce({ status: "changed" }).mockResolvedValueOnce({ status: "saved", stamp: "4:4" });
    await saveViewer();
    await overwriteSave();
    expect(api.localTextSave).toHaveBeenLastCalledWith("/home/me/notes.txt", "two", true, null);
    expect(session()).toMatchObject({ guard: null, savedText: "two", stamp: "4:4" });
  });

  it("Save as copy asks for a path, writes there without a stamp and continues on the copy", async () => {
    vi.mocked(api.localTextSave).mockResolvedValueOnce({ status: "changed" }).mockResolvedValueOnce({ status: "saved", stamp: "5:5" });
    vi.mocked(api.chooseCopyPath).mockResolvedValue("/home/me/notes (copy).txt");
    await saveViewer();
    await startSaveAsCopy();
    expect(api.chooseCopyPath).toHaveBeenCalledWith("/home/me/notes (copy).txt");
    expect(api.localTextSave).toHaveBeenLastCalledWith("/home/me/notes (copy).txt", "two", true, null);
    expect(session()).toMatchObject({ guard: null, name: "notes (copy).txt", source: { kind: "local", path: "/home/me/notes (copy).txt" }, stamp: "5:5" });
    expect(isDirty(session()!)).toBe(false);
  });

  it("cancelling the save-as dialog changes nothing", async () => {
    vi.mocked(api.localTextSave).mockResolvedValueOnce({ status: "changed" });
    vi.mocked(api.chooseCopyPath).mockResolvedValue(null);
    await saveViewer();
    await startSaveAsCopy();
    expect(session()).toMatchObject({ guard: "conflict" });
    expect(api.localTextSave).toHaveBeenCalledTimes(1);
  });

  it("a failed save keeps the text and shows the message", async () => {
    vi.mocked(api.localTextSave).mockRejectedValue("disk full");
    await saveViewer();
    expect(session()).toMatchObject({ error: "disk full", saving: false, text: "two" });
  });

  it("does nothing when nothing changed or in View mode", async () => {
    setViewerText("one");
    await saveViewer();
    expect(api.localTextSave).not.toHaveBeenCalled();
    discardAndClose();
    vi.mocked(api.localTextOpen).mockResolvedValue(localOpen("one"));
    await startViewer("view", "left");
    await saveViewer();
    expect(api.localTextSave).not.toHaveBeenCalled();
  });

  it("Edit switches a read-only viewer to editable", async () => {
    discardAndClose();
    vi.mocked(api.localTextOpen).mockResolvedValue(localOpen("one"));
    await startViewer("view", "left");
    switchToEdit();
    expect(session()?.mode).toBe("edit");
  });
});

describe("saving JSON", () => {
  beforeEach(async () => {
    browse().setCursor("left", 2);
    vi.mocked(api.localTextOpen).mockResolvedValue(localOpen('{"a":1}'));
    await startViewer("edit", "left");
  });

  it("invalid JSON is allowed after a warning, never silently", async () => {
    vi.mocked(api.localTextSave).mockResolvedValue({ status: "saved", stamp: "1:1" });
    setViewerText('{"a":}');
    await saveViewer();
    expect(session()).toMatchObject({ guard: "invalid-json" });
    expect(api.localTextSave).not.toHaveBeenCalled();
    await confirmInvalidJsonSave();
    expect(api.localTextSave).toHaveBeenCalledTimes(1);
    expect(session()).toMatchObject({ guard: null, savedText: '{"a":}' });
  });

  it("valid JSON saves without a warning", async () => {
    vi.mocked(api.localTextSave).mockResolvedValue({ status: "saved", stamp: "1:1" });
    setViewerText('{"a":2}');
    await saveViewer();
    expect(session()?.guard).toBeNull();
    expect(api.localTextSave).toHaveBeenCalledTimes(1);
  });
});

describe("saving a server object", () => {
  beforeEach(async () => {
    vi.mocked(api.s3TextOpen).mockResolvedValue(s3Open("a,b\r\n1,2\r\n"));
    await startViewer("edit", "right");
    setViewerText("a,b\r\n1,3\r\n");
  });

  it("puts the object with the same Content-Type and metadata and the ETag, then refreshes the panel", async () => {
    vi.mocked(api.s3TextSave).mockResolvedValue({ status: "saved", stamp: '"e2"' });
    await saveViewer();
    expect(api.s3TextSave).toHaveBeenCalledWith({
      profileId: "p1", bucket: "alpha", key: "in/t.csv", text: "a,b\r\n1,3\r\n", bom: true,
      contentType: "text/csv", metadata: { owner: "team-a" }, expectedEtag: '"e1"', createOnly: false,
    });
    expect(session()).toMatchObject({ source: { etag: '"e2"' }, savedText: "a,b\r\n1,3\r\n" });
    expect(panelLoader.openPath).toHaveBeenCalledWith("right", "in/");
  });

  it("a remotely changed object asks Overwrite, Save as copy or Cancel", async () => {
    vi.mocked(api.s3TextSave).mockResolvedValueOnce({ status: "changed" }).mockResolvedValueOnce({ status: "saved", stamp: '"e3"' });
    await saveViewer();
    expect(session()).toMatchObject({ guard: "conflict" });
    await overwriteSave();
    expect(api.s3TextSave).toHaveBeenLastCalledWith(expect.objectContaining({ expectedEtag: null, createOnly: false }));
    expect(session()).toMatchObject({ guard: null, source: { etag: '"e3"' } });
  });

  it("Save as copy on a server asks for a name and creates a new object", async () => {
    vi.mocked(api.s3TextSave).mockResolvedValueOnce({ status: "changed" }).mockResolvedValueOnce({ status: "saved", stamp: '"c1"' });
    await saveViewer();
    await startSaveAsCopy();
    expect(session()).toMatchObject({ guard: "copy-name" });
    await submitCopyName("t (copy).csv");
    expect(api.s3TextSave).toHaveBeenLastCalledWith(expect.objectContaining({ key: "in/t (copy).csv", expectedEtag: null, createOnly: true }));
    expect(session()).toMatchObject({ guard: null, name: "t (copy).csv", source: { key: "in/t (copy).csv", etag: '"c1"' } });
    expect(panelLoader.openPath).toHaveBeenCalledWith("right", "in/");
  });

  it("a name that already exists keeps the name dialog open with the error", async () => {
    vi.mocked(api.s3TextSave).mockResolvedValueOnce({ status: "changed" }).mockRejectedValueOnce("An object with that name already exists.");
    await saveViewer();
    await startSaveAsCopy();
    await submitCopyName("taken.csv");
    expect(session()).toMatchObject({ guard: "copy-name", error: "An object with that name already exists." });
  });

  it("a name with a slash or an empty name is refused without a call", async () => {
    vi.mocked(api.s3TextSave).mockResolvedValueOnce({ status: "changed" });
    await saveViewer();
    await startSaveAsCopy();
    await submitCopyName("a/b.csv");
    await submitCopyName("  ");
    expect(api.s3TextSave).toHaveBeenCalledTimes(1);
    expect(session()?.error).not.toBe("");
  });
});
