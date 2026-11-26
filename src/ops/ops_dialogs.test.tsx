// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpsDialogs } from "./ops_dialogs";
import { useOpsStore, type Dialog } from "./ops_store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useOpsStore.setState({ dialog: null });
});

const conflict = (name: string) => ({
  dest: `alpha/in/${name}`,
  incoming_size: 5,
  incoming_modified: 100,
  existing_size: 3,
  existing_modified: 50,
});

function openConflicts(total: number, index: number) {
  const conflicts = Array.from({ length: total }, (_, i) => conflict(`f${i}.txt`));
  const dialog = {
    kind: "conflicts",
    side: "left",
    destSide: "right",
    request: {},
    summary: { conflicts, conflict_count: total },
    index,
    perItem: {},
  } as unknown as Dialog;
  useOpsStore.setState({ dialog });
  act(() => root.render(<OpsDialogs />));
}

const labels = () => Array.from(document.querySelectorAll("button")).map((b) => b.textContent);

describe("conflict dialog buttons", () => {
  it("a single conflict has no 'all' buttons, only Overwrite, Skip, Keep both and Cancel", () => {
    openConflicts(1, 0);
    expect(labels()).toEqual(["Overwrite", "Skip", "Keep both", "Cancel"]);
  });

  it("the last of several conflicts also has no 'all' buttons", () => {
    openConflicts(3, 2);
    expect(labels()).toEqual(["Overwrite", "Skip", "Keep both", "Cancel"]);
  });

  it("with conflicts still to come the 'all' buttons are shown", () => {
    openConflicts(3, 0);
    expect(labels()).toEqual(["Overwrite", "Skip", "Keep both", "Overwrite all", "Skip all", "Keep both all", "Cancel"]);
    openConflicts(3, 1);
    expect(labels()).toContain("Skip all");
  });
});
