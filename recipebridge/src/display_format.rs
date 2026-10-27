//! Value display formats shared by web (wasm) and native (UniFFI): fixed en-US
//! shapes, independent of any device locale and free of `Intl`/`NumberFormatter`.
//!
//! Pinned by `packages/shared/golden-vectors/display-format.json`, which the
//! tests below read directly (its amounts render through
//! [`crate::format_amount_labeled`]); the web and Swift suites read the same file
//! as binding checks. Plain dates are Gregorian calendar components, with no
//! timezone conversion; timestamps stay platform code.

use serde::{Deserialize, Serialize};
#[cfg(feature = "wasm")]
use tsify_next::Tsify;
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

use crate::{WMeasureEstimate, WUnavailableReason};

/// Which rounding convention a compact nutrition figure uses.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "wasm", derive(Tsify), tsify(from_wasm_abi))]
#[serde(rename_all = "lowercase")]
pub enum WCompactUnit {
    /// A whole number, halves rounding up.
    Kcal,
    /// One decimal, halves rounding up, a trailing `.0` dropped.
    Macro,
}

/// Insert thousands separators into a plain decimal string (`-1234.5` ->
/// `-1,234.5`). Input is Rust `Display` output, which never uses an exponent.
fn group_thousands(plain: &str) -> String {
    let (sign, rest) = plain
        .strip_prefix('-')
        .map_or(("", plain), |rest| ("-", rest));
    let (int, frac) = rest
        .split_once('.')
        .map_or((rest, None), |(i, f)| (i, Some(f)));
    let mut out = String::with_capacity(plain.len() + int.len() / 3);
    out.push_str(sign);
    for (index, digit) in int.chars().enumerate() {
        if index > 0 && (int.len() - index) % 3 == 0 {
            out.push(',');
        }
        out.push(digit);
    }
    if let Some(frac) = frac {
        out.push('.');
        out.push_str(frac);
    }
    out
}

/// Round the shortest round-trip decimal of `abs` (what a person reads, so
/// `1.005` is `1.005` and rounds up) half away from zero to `max` places.
/// Returns the integer and fraction digit strings.
fn round_half_away(abs: f64, max: usize) -> (String, String) {
    let text = abs.to_string();
    let (int, frac) = text.split_once('.').unwrap_or((&text, ""));
    if frac.len() <= max {
        return (int.to_string(), frac.to_string());
    }
    let round_up = frac.as_bytes()[max] >= b'5';
    let mut digits: Vec<u8> = int.bytes().chain(frac.bytes().take(max)).collect();
    if round_up {
        let mut index = digits.len();
        loop {
            if index == 0 {
                digits.insert(0, b'1');
                break;
            }
            index -= 1;
            if digits[index] == b'9' {
                digits[index] = b'0';
            } else {
                digits[index] += 1;
                break;
            }
        }
    }
    let split = digits.len() - max;
    let digits = String::from_utf8_lossy(&digits).into_owned();
    (digits[..split].to_string(), digits[split..].to_string())
}

/// USD text: grouping, `min..=max` fraction digits (half away from zero), a
/// leading `-` for a negative value (`-$5.00`; the sign is never spelled `+`).
/// Nonzero amounts below display precision use a signed threshold; only exact
/// zero prints as zero. Non-finite values print as `$NaN` / `$∞`. Callers pass
/// `Intl`'s USD defaults (2 and 2) unless a surface needs other precision.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn format_currency(value: f64, min_fraction_digits: u32, max_fraction_digits: u32) -> String {
    if value.is_nan() {
        return "$NaN".to_string();
    }
    let sign = if value.is_sign_negative() && value != 0.0 {
        "-"
    } else {
        ""
    };
    if value.is_infinite() {
        return format!("{sign}$∞");
    }
    let quantum = 10_f64.powf(-f64::from(max_fraction_digits));
    if value != 0.0 && value.abs() < quantum {
        let threshold = if max_fraction_digits == 0 {
            "1".to_string()
        } else {
            format!("0.{}1", "0".repeat(max_fraction_digits as usize - 1))
        };
        return format!("{sign}<${threshold}");
    }
    let min = min_fraction_digits.min(max_fraction_digits) as usize;
    let (int, mut frac) = round_half_away(value.abs(), max_fraction_digits as usize);
    while frac.len() > min && frac.ends_with('0') {
        frac.pop();
    }
    while frac.len() < min {
        frac.push('0');
    }
    let is_zero = int.bytes().chain(frac.bytes()).all(|digit| digit == b'0');
    let sign = if is_zero { "" } else { sign };
    let int = group_thousands(&int);
    if frac.is_empty() {
        format!("{sign}${int}")
    } else {
        format!("{sign}${int}.{frac}")
    }
}

/// A bare numeric field: the shortest round-trip decimal, no grouping and no
/// rounding (`0.1` -> `0.1`, `1234567` -> `1234567`, `-0` -> `0`).
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn format_number(value: f64) -> String {
    if value.is_nan() {
        "NaN".to_string()
    } else if value.is_infinite() {
        if value < 0.0 { "-Infinity" } else { "Infinity" }.to_string()
    } else if value == 0.0 {
        "0".to_string()
    } else {
        value.to_string()
    }
}

/// A grouped count, rounded half away from zero, with no trailing zeroes.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn format_count(value: f64, max_fraction_digits: u32) -> String {
    if !value.is_finite() {
        return format_number(value).replace("Infinity", "∞");
    }
    let (int, mut frac) = round_half_away(value.abs(), max_fraction_digits as usize);
    while frac.ends_with('0') {
        frac.pop();
    }
    let sign = if value < 0.0 && int.bytes().chain(frac.bytes()).any(|digit| digit != b'0') {
        "-"
    } else {
        ""
    };
    let int = group_thousands(&int);
    if frac.is_empty() {
        format!("{sign}{int}")
    } else {
        format!("{sign}{int}.{frac}")
    }
}

/// Missing or empty text uses the declared label, otherwise `—` in a list or
/// `Not recorded` in detail. Nonempty text (including `0` and `No`) is evidence.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn format_text(value: Option<String>, empty_label: Option<String>, detail: bool) -> String {
    value.filter(|value| !value.is_empty()).unwrap_or_else(|| {
        empty_label.unwrap_or_else(|| if detail { "Not recorded" } else { "—" }.to_string())
    })
}

/// A real Gregorian `YYYY-MM-DD` day as `MMM d, yyyy`. Invalid inputs stay
/// visible unchanged. Calendar components need no timezone database.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn format_plain_date(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
    {
        return value.to_string();
    }
    let component = |start: usize, end: usize| {
        bytes[start..end]
            .iter()
            .fold(0_u32, |number, digit| number * 10 + u32::from(digit - b'0'))
    };
    let year = component(0, 4);
    let month = component(5, 7);
    let day = component(8, 10);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        4 | 6 | 9 | 11 => 30,
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => 0,
    };
    if year == 0 || day == 0 || day > days {
        return value.to_string();
    }
    let name = match month {
        1 => "Jan",
        2 => "Feb",
        3 => "Mar",
        4 => "Apr",
        5 => "May",
        6 => "Jun",
        7 => "Jul",
        8 => "Aug",
        9 => "Sep",
        10 => "Oct",
        11 => "Nov",
        12 => "Dec",
        _ => return value.to_string(),
    };
    format!("{name} {day}, {year}")
}

fn compact_number_text(value: f64, unit: WCompactUnit) -> String {
    let rounded = match unit {
        WCompactUnit::Kcal => (value + 0.5).floor(),
        // `value + EPSILON` nudges a binary-just-below half (12.25 is exact, 1.005 is not)
        // over the line, matching the web's `roundTo(value, 1)`.
        WCompactUnit::Macro => ((value + f64::EPSILON) * 10.0 + 0.5).floor() / 10.0,
    };
    group_thousands(&format_number(rounded))
}

/// One compact nutrition figure or range: a range joins with an en dash, and a
/// degenerate one (`upper == lower`) prints once.
fn compact_range_text(lower: f64, upper: Option<f64>, unit: WCompactUnit) -> String {
    let lower_text = compact_number_text(lower, unit);
    match upper {
        Some(upper) if upper != lower => {
            format!("{lower_text}–{}", compact_number_text(upper, unit))
        }
        _ => lower_text,
    }
}

/// The one-line macro/cost cell: a partial estimate ends in `+`, and anything
/// unavailable or pending is `—`.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn format_compact_estimate(estimate: WMeasureEstimate, unit: WCompactUnit) -> String {
    match estimate {
        WMeasureEstimate::Complete { lower, upper, .. } => compact_range_text(lower, upper, unit),
        WMeasureEstimate::Partial { lower, upper, .. } => {
            format!("{}+", compact_range_text(lower, upper, unit))
        }
        WMeasureEstimate::Unavailable { .. } | WMeasureEstimate::Pending { .. } => "—".to_string(),
    }
}

/// Which number rule a long-form estimate label uses.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "wasm", derive(Tsify), tsify(from_wasm_abi))]
#[serde(rename_all = "lowercase")]
pub enum WEstimateMeasure {
    /// USD with cents.
    Cost,
    /// A whole number, grouped.
    Kcal,
    /// One decimal, grouped, a trailing `.0` dropped.
    Macro,
    /// A fraction printed as a one-decimal percent (`0.333` -> `33.3%`).
    Share,
}

fn measure_number_text(value: f64, measure: WEstimateMeasure) -> String {
    match measure {
        WEstimateMeasure::Cost => format_currency(value, 2, 2),
        WEstimateMeasure::Kcal => compact_number_text(value, WCompactUnit::Kcal),
        WEstimateMeasure::Macro => compact_number_text(value, WCompactUnit::Macro),
        WEstimateMeasure::Share => compact_number_text(value * 100.0, WCompactUnit::Macro),
    }
}

/// The long form of an estimate for detail pages and labels: the figure or
/// range, then `unit` once (`1,500–2,250 kcal`), then the confidence language
/// (` known · partial`, ` · includes inferred zero`). Pending is `Pending`,
/// not-applicable `N/A`, and anything else unavailable `—`.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn format_estimate(
    estimate: WMeasureEstimate,
    measure: WEstimateMeasure,
    unit: Option<String>,
) -> String {
    let (lower, upper, coverage, partial) = match estimate {
        WMeasureEstimate::Pending { .. } => return "Pending".to_string(),
        WMeasureEstimate::Unavailable {
            reason: WUnavailableReason::NotApplicable,
            ..
        } => return "N/A".to_string(),
        WMeasureEstimate::Unavailable { .. } => return "—".to_string(),
        WMeasureEstimate::Complete {
            lower,
            upper,
            coverage,
        } => (lower, upper, coverage, false),
        WMeasureEstimate::Partial {
            lower,
            upper,
            coverage,
        } => (lower, upper, coverage, true),
    };
    let mut text = measure_number_text(lower, measure);
    if let Some(upper) = upper.filter(|upper| *upper != lower) {
        text.push('–');
        text.push_str(&measure_number_text(upper, measure));
    }
    if measure == WEstimateMeasure::Share {
        text.push('%');
    }
    if let Some(unit) = unit.filter(|unit| !unit.is_empty()) {
        text.push(' ');
        text.push_str(&unit);
    }
    if partial {
        text.push_str(" known · partial");
    }
    if coverage.inferred_zero > 0 {
        text.push_str(" · includes inferred zero");
    }
    text
}

/// A bare calorie figure: whole, grouped, `kcal` (`1,234 kcal`).
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn format_kcal(value: f64) -> String {
    format!("{} kcal", compact_number_text(value, WCompactUnit::Kcal))
}

/// Two USD values joined by an en dash (`$2.00–$3.00`); a missing or equal
/// upper prints once.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn format_currency_range(lower: f64, upper: Option<f64>) -> String {
    let lower_text = format_currency(lower, 2, 2);
    match upper {
        Some(upper) if upper != lower => {
            format!("{lower_text}–{}", format_currency(upper, 2, 2))
        }
        _ => lower_text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct ValueVector {
        value: f64,
        out: String,
    }

    #[derive(Deserialize)]
    struct EstimateVector {
        unit: WCompactUnit,
        estimate: WMeasureEstimate,
        out: String,
    }

    #[derive(Deserialize)]
    struct LabelVector {
        measure: WEstimateMeasure,
        unit: Option<String>,
        estimate: WMeasureEstimate,
        out: String,
    }

    #[derive(Deserialize)]
    struct RangeVector {
        lower: f64,
        upper: Option<f64>,
        out: String,
    }

    #[derive(Deserialize)]
    struct AmountVector {
        unit: String,
        value: f64,
        upper: Option<f64>,
        out: String,
    }

    #[derive(Deserialize)]
    struct DateVector {
        #[serde(rename = "in")]
        input: String,
        out: String,
    }

    #[derive(Deserialize)]
    struct TextVector {
        value: Option<String>,
        #[serde(rename = "emptyLabel")]
        empty_label: Option<String>,
        detail: bool,
        out: String,
    }

    #[derive(Deserialize)]
    struct CountVector {
        value: f64,
        decimals: u32,
        out: String,
    }

    #[derive(Deserialize)]
    struct Vectors {
        currency: Vec<ValueVector>,
        #[serde(rename = "signedCurrency")]
        signed_currency: Vec<ValueVector>,
        number: Vec<ValueVector>,
        #[serde(rename = "plainDate")]
        plain_date: Vec<DateVector>,
        text: Vec<TextVector>,
        count: Vec<CountVector>,
        #[serde(rename = "compactEstimate")]
        compact_estimate: Vec<EstimateVector>,
        estimate: Vec<LabelVector>,
        kcal: Vec<ValueVector>,
        #[serde(rename = "currencyRange")]
        currency_range: Vec<RangeVector>,
        amount: Vec<AmountVector>,
    }

    fn vectors() -> Vectors {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../packages/shared/golden-vectors/display-format.json"
        );
        let text = std::fs::read_to_string(path).unwrap();
        serde_json::from_str(&text).unwrap()
    }

    #[test]
    fn currency_matches_the_shared_vectors() {
        for v in vectors()
            .currency
            .into_iter()
            .chain(vectors().signed_currency)
        {
            assert_eq!(format_currency(v.value, 2, 2), v.out, "value {}", v.value);
        }
    }

    #[test]
    fn number_matches_the_shared_vectors() {
        for v in vectors().number {
            assert_eq!(format_number(v.value), v.out, "value {}", v.value);
        }
    }

    #[test]
    fn plain_date_matches_the_shared_vectors() {
        for v in vectors().plain_date {
            assert_eq!(format_plain_date(&v.input), v.out, "input {}", v.input);
        }
    }

    #[test]
    fn text_matches_the_shared_vectors() {
        for v in vectors().text {
            assert_eq!(format_text(v.value, v.empty_label, v.detail), v.out);
        }
    }

    #[test]
    fn count_matches_the_shared_vectors() {
        for v in vectors().count {
            assert_eq!(format_count(v.value, v.decimals), v.out);
        }
    }

    #[test]
    fn compact_estimate_matches_the_shared_vectors() {
        for v in vectors().compact_estimate {
            let label = format!("{:?}", v.estimate);
            assert_eq!(
                format_compact_estimate(v.estimate, v.unit),
                v.out,
                "{label}"
            );
        }
    }

    #[test]
    fn estimate_label_matches_the_shared_vectors() {
        for v in vectors().estimate {
            let label = format!("{:?}", v.estimate);
            assert_eq!(
                format_estimate(v.estimate, v.measure, v.unit),
                v.out,
                "{label}"
            );
        }
    }

    #[test]
    fn kcal_matches_the_shared_vectors() {
        for v in vectors().kcal {
            assert_eq!(format_kcal(v.value), v.out, "value {}", v.value);
        }
    }

    #[test]
    fn currency_range_matches_the_shared_vectors() {
        for v in vectors().currency_range {
            assert_eq!(format_currency_range(v.lower, v.upper), v.out);
        }
    }

    #[test]
    fn amount_matches_the_shared_vectors() {
        for v in vectors().amount {
            let label = format!("{:?} {} {:?}", v.unit, v.value, v.upper);
            let amount = crate::WAmount {
                unit: v.unit,
                value: v.value,
                upper_value: v.upper,
            };
            assert_eq!(crate::format_amount_labeled(amount), v.out, "{label}");
        }
    }

    #[test]
    fn currency_honours_custom_fraction_digits() {
        // Sub-cent AI usage costs ask for more precision; whole-dollar surfaces for none.
        assert_eq!(format_currency(0.00123, 2, 4), "$0.0012");
        assert_eq!(format_currency(0.5, 2, 4), "$0.50");
        assert_eq!(format_currency(1234.567, 0, 0), "$1,235");
        assert_eq!(format_currency(999.999, 2, 2), "$1,000.00");
        assert_eq!(format_currency(f64::NAN, 2, 2), "$NaN");
    }

    #[test]
    fn nonzero_money_never_displays_as_zero() {
        assert_eq!(format_currency(0.004, 2, 2), "<$0.01");
        assert_eq!(format_currency(-0.004, 2, 2), "-<$0.01");
        assert_eq!(format_currency(0.00000001, 4, 6), "<$0.000001");
        assert_eq!(format_currency(-0.00000001, 4, 6), "-<$0.000001");
        assert_eq!(format_currency(f64::MIN_POSITIVE, 2, 2), "<$0.01");
        assert_eq!(format_currency(0.25, 0, 0), "<$1");
        assert_eq!(format_currency(-0.0, 2, 2), "$0.00");
    }

    #[test]
    fn plain_number_never_uses_an_exponent() {
        assert_eq!(format_number(-0.0), "0");
        assert_eq!(format_number(1e21), "1000000000000000000000");
    }
}
