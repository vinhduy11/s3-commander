//! Exponential delay after failed unlock attempts, persisted so a restart does not reset it.
//! Pure logic with an injectable clock; no Tauri dependency.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::vault::{Vault, VaultError};
#[cfg(test)]
use crate::vault::KdfParams;

pub const MAX_DELAY_MS: u64 = 300_000;

pub trait Clock {
    fn now_ms(&self) -> u64;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }
}

/// Delay after the n-th failure in a row: 1 s, 2 s, 4 s ... capped at 5 minutes.
pub fn delay_ms(failures: u32) -> u64 {
    if failures == 0 {
        return 0;
    }
    1000u64.saturating_mul(1u64 << (failures - 1).min(20)).min(MAX_DELAY_MS)
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct State {
    failures: u32,
    blocked_until_ms: u64,
}

pub struct UnlockThrottle {
    path: PathBuf,
    state: State,
}

impl UnlockThrottle {
    /// Missing or unreadable file: no delay.
    pub fn load(path: PathBuf) -> Self {
        let state = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Self { path, state }
    }

    /// Milliseconds left to wait. Never more than the delay the failure count allows, so a clock
    /// that was moved back cannot lock the user out for longer than the cap.
    pub fn remaining_ms(&self, clock: &dyn Clock) -> u64 {
        self.state
            .blocked_until_ms
            .saturating_sub(clock.now_ms())
            .min(delay_ms(self.state.failures))
    }

    pub fn record_failure(&mut self, clock: &dyn Clock) {
        self.state.failures = self.state.failures.saturating_add(1);
        self.state.blocked_until_ms = clock.now_ms().saturating_add(delay_ms(self.state.failures));
        self.persist();
    }

    pub fn record_success(&mut self) {
        self.state = State::default();
        self.persist();
    }

    /// Best effort: a write failure keeps the in-memory delay for this run.
    fn persist(&self) {
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let tmp = self.path.with_extension("json.tmp");
        if let Ok(bytes) = serde_json::to_vec(&self.state) {
            if std::fs::write(&tmp, bytes).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
    }
}

/// Unlock behind the throttle: refuses before any key derivation while the delay runs; only a
/// wrong key (not an I/O error) counts as a failure; success resets the count.
pub fn unlock_guarded(
    vault: &mut Vault,
    throttle: &mut UnlockThrottle,
    clock: &dyn Clock,
    master_key: &str,
) -> Result<(), VaultError> {
    let wait = throttle.remaining_ms(clock);
    if wait > 0 {
        return Err(VaultError::Throttled(wait.div_ceil(1000)));
    }
    match vault.unlock(master_key) {
        Ok(()) => {
            throttle.record_success();
            Ok(())
        }
        Err(VaultError::Decrypt) => {
            throttle.record_failure(clock);
            Err(VaultError::Decrypt)
        }
        Err(other) => Err(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct FakeClock(Cell<u64>);
    impl Clock for FakeClock {
        fn now_ms(&self) -> u64 {
            self.0.get()
        }
    }

    fn setup() -> (tempfile::TempDir, Vault, UnlockThrottle, FakeClock) {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::with_target(dir.path().join("vault.json"), KdfParams::LEGACY);
        vault.create("right").unwrap();
        vault.lock();
        let throttle = UnlockThrottle::load(dir.path().join("unlock_throttle.json"));
        (dir, vault, throttle, FakeClock(Cell::new(1_000_000)))
    }

    #[test]
    fn delay_sequence_doubles_and_caps_at_five_minutes() {
        let seq: Vec<u64> = (0..=12).map(delay_ms).collect();
        assert_eq!(&seq[..6], &[0, 1000, 2000, 4000, 8000, 16000]);
        assert_eq!(seq[9], 256_000);
        assert_eq!(seq[10], 300_000);
        assert_eq!(delay_ms(u32::MAX), 300_000);
    }

    #[test]
    fn failures_block_for_the_delay_then_release() {
        let (_dir, mut vault, mut throttle, clock) = setup();
        assert!(matches!(unlock_guarded(&mut vault, &mut throttle, &clock, "bad"), Err(VaultError::Decrypt)));
        assert_eq!(throttle.remaining_ms(&clock), 1000);
        clock.0.set(clock.0.get() + 400);
        assert_eq!(throttle.remaining_ms(&clock), 600);
        clock.0.set(clock.0.get() + 600);
        assert_eq!(throttle.remaining_ms(&clock), 0);
        assert!(matches!(unlock_guarded(&mut vault, &mut throttle, &clock, "bad"), Err(VaultError::Decrypt)));
        assert_eq!(throttle.remaining_ms(&clock), 2000);
    }

    #[test]
    fn refuses_during_the_wait_without_running_the_key_derivation() {
        let (_dir, mut vault, mut throttle, clock) = setup();
        let _ = unlock_guarded(&mut vault, &mut throttle, &clock, "bad");
        let before = crate::vault::derive_count_for_tests();
        let err = unlock_guarded(&mut vault, &mut throttle, &clock, "right").unwrap_err();
        assert!(matches!(err, VaultError::Throttled(1)));
        assert_eq!(crate::vault::derive_count_for_tests(), before, "Argon2 must not run during the wait");
        assert!(!vault.is_unlocked(), "even the right key is refused during the wait");
        assert_eq!(err.to_string(), "Too many failed attempts. Try again in 1 s.");
    }

    #[test]
    fn success_resets_the_count() {
        let (_dir, mut vault, mut throttle, clock) = setup();
        let _ = unlock_guarded(&mut vault, &mut throttle, &clock, "bad");
        clock.0.set(clock.0.get() + 1000);
        unlock_guarded(&mut vault, &mut throttle, &clock, "right").unwrap();
        assert_eq!(throttle.remaining_ms(&clock), 0);
        vault.lock();
        let _ = unlock_guarded(&mut vault, &mut throttle, &clock, "bad");
        assert_eq!(throttle.remaining_ms(&clock), 1000, "starts again at 1 s");
    }

    #[test]
    fn the_delay_survives_a_restart() {
        let (dir, mut vault, mut throttle, clock) = setup();
        for _ in 0..3 {
            clock.0.set(clock.0.get() + 10_000);
            let _ = unlock_guarded(&mut vault, &mut throttle, &clock, "bad");
        }
        assert_eq!(throttle.remaining_ms(&clock), 4000);
        let reloaded = UnlockThrottle::load(dir.path().join("unlock_throttle.json"));
        assert_eq!(reloaded.remaining_ms(&clock), 4000);
    }

    #[test]
    fn a_clock_moved_back_never_waits_longer_than_the_cap_allows() {
        let (_dir, mut vault, mut throttle, clock) = setup();
        let _ = unlock_guarded(&mut vault, &mut throttle, &clock, "bad");
        clock.0.set(0);
        assert_eq!(throttle.remaining_ms(&clock), 1000);
    }

    #[test]
    fn io_errors_do_not_count_as_failed_attempts() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::with_target(dir.path().join("missing.json"), KdfParams::LEGACY);
        let mut throttle = UnlockThrottle::load(dir.path().join("t.json"));
        let clock = FakeClock(Cell::new(5));
        assert!(matches!(unlock_guarded(&mut vault, &mut throttle, &clock, "x"), Err(VaultError::NotFound)));
        assert_eq!(throttle.remaining_ms(&clock), 0);
    }
}
