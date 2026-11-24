use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// Minimum time between background update checks. Manual checks bypass this.
#[allow(dead_code)]
const CHECK_INTERVAL_SECS: i64 = 24 * 60 * 60;
/// Network timeout for a single manifest request.
#[allow(dead_code)]
const CHECK_TIMEOUT_SECS: u64 = 10;
/// A release must be at least this old before auto-update installs it, so a
/// broken release cannot reach everyone within minutes of being published.
#[allow(dead_code)]
const MIN_AUTO_INSTALL_AGE_SECS: i64 = 24 * 60 * 60;
#[allow(dead_code)]
const STATE_FILE: &str = "update-state.json";
#[allow(dead_code)]
const RELEASES_API: &str = "https://api.github.com/repos/kua8/Nectar/releases?per_page=10";
/// Custom Nectar fork protection: blocks upstream `kua8/Nectar` checks & silent overwrites.
pub const UPSTREAM_UPDATER_DISABLED: bool = true;

pub fn is_disabled_for_fork() -> bool {
    UPSTREAM_UPDATER_DISABLED
}

#[allow(dead_code)]
static CHECK_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[allow(dead_code)]
static UPDATE_BUSY: AtomicBool = AtomicBool::new(false);
static LAST_CHECK: Mutex<Option<UpdateCheckResult>> = Mutex::new(None);

#[derive(Clone, Default, Serialize)]
pub struct UpdateCheckResult {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct PersistedUpdateState {
    last_check: i64,
    app_version: String,
    version: String,
    date: String,
    #[serde(default)]
    channel: String,
}

#[allow(dead_code)]
fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[allow(dead_code)]
fn state_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(STATE_FILE))
}

#[allow(dead_code)]
fn read_state(app: &AppHandle) -> PersistedUpdateState {
    state_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

#[allow(dead_code)]
fn result_from_state(state: &PersistedUpdateState) -> UpdateCheckResult {
    if state.version.is_empty() {
        return UpdateCheckResult::default();
    }
    UpdateCheckResult {
        available: true,
        version: Some(state.version.clone()),
        date: (!state.date.is_empty()).then(|| state.date.clone()),
        body: None,
    }
}

#[allow(dead_code)]
pub fn release_is_old_enough(result: &UpdateCheckResult) -> bool {
    match result.date.as_deref().and_then(parse_rfc3339_utc) {
        Some(published) => now_secs() - published >= MIN_AUTO_INSTALL_AGE_SECS,
        None => false,
    }
}

/// Checks for an update — disabled on this custom Nectar fork.
pub async fn check(_app: &AppHandle, _force: bool) -> Result<UpdateCheckResult, String> {
    Ok(UpdateCheckResult::default())
}

/// Downloads and installs an update — disabled on this custom Nectar fork.
pub async fn install(_app: &AppHandle) -> Result<(), String> {
    Err("Upstream auto-updates are disabled on this custom Nectar fork.".to_string())
}

/// Startup entry point: upstream checks disabled for custom fork safety.
pub async fn run_startup_check(app: AppHandle) {
    if UPSTREAM_UPDATER_DISABLED {
        let _ = app.emit("update-available", &UpdateCheckResult::default());
        return;
    }
    let _ = Duration::from_secs(CHECK_TIMEOUT_SECS);
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle, force: bool) -> Result<UpdateCheckResult, String> {
    let result = check(&app, force).await?;
    let _ = app.emit("update-available", &result);
    Ok(result)
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    install(&app).await
}

#[tauri::command]
pub fn get_update_state(_app: AppHandle) -> UpdateCheckResult {
    if UPSTREAM_UPDATER_DISABLED {
        return UpdateCheckResult::default();
    }
    if let Ok(cached) = LAST_CHECK.lock() {
        if let Some(result) = cached.as_ref() {
            return result.clone();
        }
    }
    UpdateCheckResult::default()
}

fn parse_rfc3339_utc(value: &str) -> Option<i64> {
    if value.len() < 20 || !value.ends_with('Z') {
        return None;
    }
    let bytes = value.as_bytes();
    if bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let year: i64 = value.get(0..4)?.parse().ok()?;
    let month: i64 = value.get(5..7)?.parse().ok()?;
    let day: i64 = value.get(8..10)?.parse().ok()?;
    let hour: i64 = value.get(11..13)?.parse().ok()?;
    let minute: i64 = value.get(14..16)?.parse().ok()?;
    let second: i64 = value.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let days = days_from_civil(year, month, day);
    Some(days * 86_400 + hour * 3_600 + minute * 60 + second)
}

/// Howard Hinnant's days-from-civil algorithm.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let shifted_month = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::{days_from_civil, parse_rfc3339_utc};

    #[test]
    fn parses_tauri_action_pub_date() {
        assert_eq!(parse_rfc3339_utc("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_utc("2026-09-13T18:14:46Z"), Some(1_789_323_286));
        assert_eq!(parse_rfc3339_utc("2026-09-13T18:14:46.123Z"), Some(1_789_323_286));
    }

    #[test]
    fn rejects_non_utc_and_malformed_dates() {
        assert_eq!(parse_rfc3339_utc("2026-09-13T18:14:46+02:00"), None);
        assert_eq!(parse_rfc3339_utc("not-a-date"), None);
        assert_eq!(parse_rfc3339_utc("2026-13-40T99:99:99Z"), None);
    }

    #[test]
    fn computes_civil_days() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2026, 9, 13), 20_709);
    }

    #[test]
    fn updater_is_disabled_for_fork() {
        assert!(super::UPSTREAM_UPDATER_DISABLED);
        assert!(super::is_disabled_for_fork());
    }
}
