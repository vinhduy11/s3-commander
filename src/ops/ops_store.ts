// Dialog state for the file operations. Kept apart from the panel store: it is small, transient
// and never holds secrets. At most one dialog is open at a time.

import { create } from "zustand";
import type { ConflictPolicy, ItemFailure, Location, Mode, PlanSummary, TopItem, TransferRequest } from "./ops_api";
import type { Side } from "../browse/browse_store";

export type NameDialogKind = "new-folder" | "rename";

export type Dialog =
  | { kind: "delete"; side: Side; location: Location; items: TopItem[]; permanent: boolean }
  | { kind: "name"; name: NameDialogKind; side: Side; location: Location; item: TopItem | null; initial: string; error: string }
  | { kind: "plan"; side: Side; destSide: Side; request: TransferRequest; summary: PlanSummary }
  | {
      kind: "conflicts";
      side: Side;
      destSide: Side;
      request: TransferRequest;
      summary: PlanSummary;
      index: number;
      perItem: Record<string, ConflictPolicy>;
    }
  | { kind: "busy"; label: string }
  | { kind: "result"; title: string; lines: string[]; failed: ItemFailure[] };

export type { Mode };

type OpsState = {
  dialog: Dialog | null;
  setDialog: (dialog: Dialog | null) => void;
};

export const useOpsStore = create<OpsState>((set) => ({
  dialog: null,
  setDialog: (dialog) => set({ dialog }),
}));
