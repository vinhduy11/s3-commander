// Typed wrappers over the AWS CLI import commands. Rust reads the config file (only on click) and
// returns only non-secret settings; the frontend never reads files.
import { invoke } from "@tauri-apps/api/core";

export type AwsProfileSettings = {
  multipart_threshold?: string | null;
  multipart_chunksize?: string | null;
  max_concurrent_requests?: string | null;
  addressing_style?: string | null;
  region?: string | null;
  endpoint_url?: string | null;
};

export const listAwsProfiles = () => invoke<string[]>("aws_config_list_profiles");

export const readAwsProfile = (name: string) => invoke<AwsProfileSettings>("aws_config_read_profile", { name });
