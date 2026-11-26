// Typed wrappers over the transfer queue commands. Only ids, requests and decisions go to Rust;
// credentials never pass through the frontend.

import { invoke } from "@tauri-apps/api/core";
import type { Resolutions, TransferRequest } from "../ops/ops_api";
import type { JobSnapshot } from "./queue_logic";

/** Queues the transfer as a background job and returns its id at once. */
export const transferStart = (profileId: string | null, request: TransferRequest, resolutions: Resolutions) =>
  invoke<string>("transfer_start", { profileId, request, resolutions });

export const transferCancel = (jobId: string) => invoke<void>("transfer_cancel", { jobId });
export const transferRetry = (jobId: string) => invoke<void>("transfer_retry", { jobId });
/** Forgets a finished job and aborts the incomplete uploads it kept. */
export const transferDismiss = (jobId: string) => invoke<void>("transfer_dismiss", { jobId });
/** Every job the backend holds (used once, when the frontend attaches). */
export const transferList = () => invoke<JobSnapshot[]>("transfer_list");
