//! Inline currency conversion for Nectar Launcher.
//!
//! Recognizes queries shaped like "100 usd to eur" / "10$ в руб" / "45eur rub"
//! only when an explicit amount plus two resolvable currency tokens are present,
//! so plain typing never triggers a lookup (matching the explicit-trigger rule
//! the launcher now follows for files and web search). Rates come from
//! open.er-api.com (keyless) and are cached for an hour.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;

use super::providers::{LauncherAction, LauncherItem};

const RATES_URL: &str = "https://open.er-api.com/v6/latest/USD";
const RATES_TTL: Duration = Duration::from_secs(60 * 60);
/// After a failed fetch, wait this long before trying again.
const RETRY_DELAY: Duration = Duration::from_secs(45);

/// Accepted currencies: ISO code plus common symbols and localized names.
/// Aliases are unambiguous — a token either maps to exactly one code or
/// matches nothing. "¥" is shared by CNY and JPY, so it maps to neither.
const CURRENCIES: &[(&str, &[&str])] = &[
    ("USD", &["usd", "$", "доллар", "доллары", "доллара", "бакс"]),
    ("EUR", &["eur", "€", "евро"]),
    ("RUB", &["rub", "₽", "руб", "рубль", "рубли", "рубля"]),
    ("UAH", &["uah", "₴", "грн", "гривна", "гривны"]),
    ("KZT", &["kzt", "₸", "тенге"]),
    ("GBP", &["gbp", "£", "фунт", "фунты"]),
    ("PLN", &["pln", "zł", "злотый", "злотых"]),
    ("TRY", &["try", "₺", "лира", "лиры"]),
    ("CNY", &["cny", "юань", "юани"]),
    ("JPY", &["jpy", "иена", "иены", "йена", "йены"]),
];

#[derive(Debug, Deserialize)]
struct ErApiPayload {
    result: String,
    #[serde(default)]
    time_last_update_unix: u64,
    #[serde(default)]
    rates: HashMap<String, f64>,
}

struct RatesCache {
    fetched_at: Option<Instant>,
    /// None = last attempt failed (or never attempted).
    rates: Option<HashMap<String, f64>>,
    updated_unix: u64,
}

static CACHE: Mutex<Option<RatesCache>> = Mutex::new(None);

/// A parsed conversion query: amount, source code, target code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversionQuery {
    pub amount: String,
    pub from: &'static str,
    pub to: &'static str,
}

/// Splits the leading numeric part ("100", "10", "1.5") from the rest of a token.
fn split_amount_token(word: &str) -> Option<(&str, &str)> {
    let mut split_at = 0usize;
    for (idx, ch) in word.char_indices() {
        if ch.is_ascii_digit() || ch == '.' || ch == ',' {
            split_at = idx + ch.len_utf8();
        } else {
            break;
        }
    }
    if split_at == 0 {
        return None;
    }
    Some((&word[..split_at], &word[split_at..]))
}

/// Resolves one token (ISO code, symbol or localized name) to a currency code.
/// Exact match only; unknown tokens resolve to nothing.
fn resolve_currency(token: &str) -> Option<&'static str> {
    let lower = token.trim().to_lowercase();
    if lower.is_empty() {
        return None;
    }
    let by_code = CURRENCIES
        .iter()
        .find(|(code, _)| code.eq_ignore_ascii_case(&lower));
    let found = by_code.or_else(|| {
        CURRENCIES
            .iter()
            .find(|(_, aliases)| aliases.iter().any(|a| a.eq_ignore_ascii_case(&lower)))
    })?;
    Some(found.0)
}

/// Parses "100 usd to eur", "10$ в руб", "45eur rub". Amount must be explicit
/// and the currencies must resolve; anything else returns None so plain typing
/// never triggers the converter.
pub fn parse_conversion(query: &str) -> Option<ConversionQuery> {
    let tokens: Vec<&str> = query
        .trim()
        .split_whitespace()
        .filter(|t| !matches!(*t, "to" | "in" | "в" | "на" | "->" | "→"))
        .collect();

    // Shape A: "<amount+source> <target>" — "100usd eur", "10$ руб".
    if tokens.len() == 2 {
        if let Some((amount_raw, source)) = split_amount_token(tokens[0]) {
            let amount = amount_raw.replace(',', ".");
            if amount.parse::<f64>().is_ok() {
                let from = resolve_currency(source)?;
                let to = resolve_currency(tokens[1])?;
                if from != to {
                    return Some(ConversionQuery { amount, from, to });
                }
                return None;
            }
        }
    }

    // Shape B: "<amount> <source> <target>" — "100 usd to eur", "10 $ руб".
    if tokens.len() == 3 {
        let amount = tokens[0].replace(',', ".");
        if amount.parse::<f64>().is_err() {
            return None;
        }
        let from = resolve_currency(tokens[1])?;
        let to = resolve_currency(tokens[2])?;
        if from != to {
            return Some(ConversionQuery { amount, from, to });
        }
    }
    None
}

/// Returns the cached rate table, refreshing it when older than an hour.
/// None when no table is available (offline, first fetch failed).
fn cached_rates() -> Option<(HashMap<String, f64>, u64)> {
    // Decide under the lock, fetch outside it: a slow or offline endpoint must
    // not serialize every launcher keystroke behind one mutex.
    let should_fetch = {
        let mut guard = CACHE.lock().ok()?;
        let cache = guard.get_or_insert_with(|| RatesCache {
            fetched_at: None,
            rates: None,
            updated_unix: 0,
        });
        let fresh = cache.fetched_at.is_some_and(|at| at.elapsed() < RATES_TTL);
        let retry_due = cache
            .fetched_at
            .is_none_or(|at| at.elapsed() >= RETRY_DELAY);
        if fresh || !retry_due {
            return cache.rates.clone().map(|r| (r, cache.updated_unix));
        }
        true
    };
    if !should_fetch {
        return None;
    }
    let fetched = fetch_rates_blocking();
    let mut guard = CACHE.lock().ok()?;
    let cache = guard.get_or_insert_with(|| RatesCache {
        fetched_at: None,
        rates: None,
        updated_unix: 0,
    });
    cache.fetched_at = Some(Instant::now());
    match fetched {
        Ok((rates, updated)) => {
            cache.rates = Some(rates.clone());
            cache.updated_unix = updated;
            Some((rates, updated))
        }
        Err(_) => cache.rates.clone().map(|r| (r, cache.updated_unix)),
    }
}

fn fetch_rates_blocking() -> Result<(HashMap<String, f64>, u64), String> {
    let runtime = tauri::async_runtime::handle();
    std::thread::spawn(move || {
        runtime.block_on(async {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(4))
                .build()
                .map_err(|e| e.to_string())?;
            let body: ErApiPayload = serde_json::from_str(
                &client
                    .get(RATES_URL)
                    .send()
                    .await
                    .map_err(|e| e.to_string())?
                    .text()
                    .await
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            if body.result != "success" || body.rates.is_empty() {
                return Err("rates payload rejected".to_string());
            }
            Ok((body.rates, body.time_last_update_unix))
        })
    })
    .join()
    .map_err(|_| "rates worker panicked".to_string())?
}

fn format_amount(value: f64) -> String {
    if value.abs() >= 1.0 {
        format!("{value:.2}")
    } else {
        format!("{value:.4}")
    }
}

/// Builds the converter row for a parsed query. None on any failure (offline,
/// unknown currency, missing rate): the launcher then shows no converter row.
pub fn conversion_item(query: &ConversionQuery) -> Option<LauncherItem> {
    let (rates, updated_unix) = cached_rates()?;
    let from_rate = *rates.get(query.from)?;
    let to_rate = *rates.get(query.to)?;
    if from_rate <= 0.0 {
        return None;
    }
    let amount: f64 = query.amount.parse().ok()?;
    let converted = (amount / from_rate) * to_rate;
    let unit_rate = to_rate / from_rate;

    let updated_label = chrono::DateTime::from_timestamp(updated_unix as i64, 0)
        .map(|dt| dt.format("%d %b %Y %H:%M UTC").to_string())
        .unwrap_or_default();
    let note = if updated_label.is_empty() {
        format!("1 {} = {:.4} {}", query.from, unit_rate, query.to)
    } else {
        format!(
            "1 {} = {:.4} {} · {}",
            query.from, unit_rate, query.to, updated_label
        )
    };

    Some(LauncherItem {
        id: format!("currency:{}->{}", query.from, query.to),
        // Reuses the calc row: Enter copies the result, the UI shows the toast.
        kind: "calc".to_string(),
        title: format!("{} {}", format_amount(converted), query.to),
        subtitle: note,
        badge: "launcher.badge.currency".to_string(),
        icon: None,
        target: format_amount(converted),
        args: None,
        hwnd: None,
        score: 9_700,
        match_indices: Vec::new(),
        requires_confirm: false,
        actions: vec![LauncherAction {
            id: "copy_path".to_string(),
            label: "Copy result".to_string(),
            shortcut: Some("Enter".to_string()),
            destructive: false,
        }],
    })
}

#[cfg(test)]
mod tests {
    use super::{parse_conversion, resolve_currency};

    #[test]
    fn parses_plain_code_form() {
        let q = parse_conversion("100 usd to eur").unwrap();
        assert_eq!(q.from, "USD");
        assert_eq!(q.to, "EUR");
        assert_eq!(q.amount, "100");
    }

    #[test]
    fn parses_fused_symbol_and_localized_alias() {
        let q = parse_conversion("10$ в руб").unwrap();
        assert_eq!(q.from, "USD");
        assert_eq!(q.to, "RUB");
        let q2 = parse_conversion("45eur uah").unwrap();
        assert_eq!(q2.from, "EUR");
        assert_eq!(q2.to, "UAH");
        let q3 = parse_conversion("2000тенге usd").unwrap();
        assert_eq!(q3.from, "KZT");
        assert_eq!(q3.to, "USD");
    }

    #[test]
    fn same_currency_or_missing_amount_is_not_a_conversion() {
        assert!(parse_conversion("100 usd to usd").is_none());
        assert!(parse_conversion("usd to eur").is_none());
        assert!(parse_conversion("hello world").is_none());
        assert!(parse_conversion("steam").is_none());
        assert!(parse_conversion("").is_none());
        assert!(parse_conversion("100 usd to eur extra").is_none());
    }

    #[test]
    fn ambiguous_or_unknown_tokens_do_not_match() {
        assert!(resolve_currency("lol").is_none());
        assert!(resolve_currency("").is_none());
        assert!(resolve_currency("¥").is_none());
        assert_eq!(resolve_currency("TRY"), Some("TRY"));
        assert_eq!(resolve_currency("евро"), Some("EUR"));
    }
}
