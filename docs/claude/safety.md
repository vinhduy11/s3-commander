# Safety

- Profile secrets are stored only encrypted in the app vault (master-key derived key); never write them to plain config files, logs, or git. The master key is never persisted in plain text.
- Real credentials, bucket names tied to real environments, and endpoints stay out of tracked files (see global "Secrets & Infra Hygiene").
- Testing against real S3 buckets: Delete/Move (F6/F8) are destructive. Use a throwaway bucket or prefix and confirm the target with the user before running anything that writes or deletes remotely.
- The vault file holds only ciphertext; losing the master key means the profiles are unrecoverable (no reset path by design). Frontend commands never return `secret_key`, and the master key is passed per call and not stored or logged.
- Vault tests use tempdirs and touch no network or database.
- AWS CLI import: `aws_config.rs` returns a fixed struct of six non-secret fields; a test proves access key, secret and token lines in the config never come back. The credentials file is never opened.
- AWS CLI import (profile form) reads only the non-secret keys listed in the roadmap from `~/.aws/config`, only when the user clicks Import; it never reads `~/.aws/credentials` or any key/secret/token value, and tests never read the real home directory.
