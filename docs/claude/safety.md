# Safety

- Profile secrets are stored only encrypted through the keychain; never write them to plain config files, logs, or git. The master key is never persisted in plain text.
- Real credentials, bucket names tied to real environments, and endpoints stay out of tracked files (see global "Secrets & Infra Hygiene").
- Testing against real S3 buckets: Delete/Move (F6/F8) are destructive. Use a throwaway bucket or prefix and confirm the target with the user before running anything that writes or deletes remotely.
