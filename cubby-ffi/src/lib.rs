//! UniFFI boundary exposing `recipebridge`'s ingredient parser to Swift on
//! iOS and macOS. Same Rust source as the WASM build the web app uses
//! (`recipebridge` itself is untouched); this crate only translates its
//! wasm-bindgen/tsify types into UniFFI records at the boundary.
//!
//! v1 is deliberately thin. The ingredient exports are infallible (the
//! underlying parser never fails; it falls back to a name-only ingredient);
//! the ISBN exports return `Option` for "not a valid code" rather than a
//! typed error. Either way there is no `uniffi::Error` here — a dead error
//! enum would trip `-D warnings`.

uniffi::setup_scaffolding!();

/// Mirrors `recipebridge::WAmount` (`unit`, `value`, `upper_value`) at the
/// UniFFI boundary. Kept in lockstep by `parse_two_cups_flour` below: any new
/// field on `WAmount` that this record does not carry silently drops data,
/// which the test's field-by-field assertions would catch.
#[derive(uniffi::Record)]
pub struct Amount {
    pub unit: String,
    pub value: f64,
    pub upper_value: Option<f64>,
}

impl From<recipebridge::WAmount> for Amount {
    fn from(amount: recipebridge::WAmount) -> Self {
        // Exhaustive destructure (no `..`): a field added to `WAmount` upstream fails
        // this to compile instead of silently being dropped from the FFI boundary.
        let recipebridge::WAmount {
            unit,
            value,
            upper_value,
        } = amount;
        Self {
            unit,
            value,
            upper_value,
        }
    }
}

/// A reduced projection of `recipebridge::WIngredient` for the PoC: `usage`
/// and `parse_notes` are review/classification metadata the native client
/// does not consume yet, so they stay off the FFI surface until a screen
/// needs them (adding a field later is additive, not breaking).
#[derive(uniffi::Record)]
pub struct ParsedIngredient {
    pub name: String,
    pub amounts: Vec<Amount>,
    pub modifier: Option<String>,
    pub optional: bool,
    /// The parser's own one-line rendering (`ingredient::Ingredient`'s `Display`), so Swift
    /// never formats amounts and units itself.
    pub display: String,
}

impl ParsedIngredient {
    fn new(ingredient: recipebridge::WIngredient, display: String) -> Self {
        Self {
            name: ingredient.name,
            amounts: ingredient.amounts.into_iter().map(Amount::from).collect(),
            modifier: ingredient.modifier,
            optional: ingredient.optional,
            display,
        }
    }
}

/// Parses one ingredient line (e.g. "2 cups flour"). Never fails: an
/// unparseable line falls back to a name-only ingredient, same as the WASM
/// consumer sees.
#[uniffi::export]
pub fn parse_ingredient(line: String) -> ParsedIngredient {
    // One parse for both the structured result and the display string — the earlier
    // version called `recipebridge::parse_ingredient` and `::format_ingredient`
    // separately, each running the (non-trivial) parse from scratch on the same line.
    let (ingredient, display) = recipebridge::parse_and_format_ingredient(&line);
    ParsedIngredient::new(ingredient, display)
}

/// The unit-alias vocabulary `parse_ingredient` recognizes for weight/volume
/// sizes (longest-first, so a caller can `join("|")` into a regex
/// alternation without re-sorting). Never hand-list these in Swift.
#[uniffi::export]
pub fn size_unit_aliases() -> Vec<String> {
    recipebridge::size_unit_aliases()
}

/// Mirrors `recipebridge::NormalizedIsbn` (`isbn13`, `isbn10`, `gtin14`) at the
/// UniFFI boundary, exhaustively destructured for the same reason `Amount`
/// is above: a field added upstream fails this to compile instead of
/// silently dropping data.
#[derive(uniffi::Record)]
pub struct NormalizedIsbn {
    pub isbn13: String,
    pub isbn10: Option<String>,
    pub gtin14: String,
}

impl From<recipebridge::NormalizedIsbn> for NormalizedIsbn {
    fn from(isbn: recipebridge::NormalizedIsbn) -> Self {
        let recipebridge::NormalizedIsbn {
            isbn13,
            isbn10,
            gtin14,
        } = isbn;
        Self {
            isbn13,
            isbn10,
            gtin14,
        }
    }
}

/// Validate either ISBN encoding and return the single identity Cubby
/// stores, or `None` when `value` is neither a valid ISBN-10 nor ISBN-13.
#[uniffi::export]
pub fn normalize_isbn(value: String) -> Option<NormalizedIsbn> {
    recipebridge::normalize_isbn(&value).map(NormalizedIsbn::from)
}

/// Classify a raw scanner code as a GTIN-14 (ISBN check-digit match, or a
/// plausible-length all-digit barcode zero-padded to 14). `None` when
/// neither applies. See `recipebridge::scan_code_gtin14` for the exact rule.
#[uniffi::export]
pub fn scan_code_gtin14(raw: String) -> Option<String> {
    recipebridge::scan_code_gtin14(&raw)
}

/// Which rounding convention a compact nutrition figure uses; mirrors
/// `recipebridge::WCompactUnit`.
#[derive(uniffi::Enum)]
pub enum CompactUnit {
    Kcal,
    Macro,
}

impl From<CompactUnit> for recipebridge::WCompactUnit {
    fn from(unit: CompactUnit) -> Self {
        match unit {
            CompactUnit::Kcal => Self::Kcal,
            CompactUnit::Macro => Self::Macro,
        }
    }
}

/// The part of a nutrition/cost estimate a compact cell reads: a known figure
/// (complete or partial) or nothing. Mirrors the status split of
/// `recipebridge::WMeasureEstimate` without its coverage metadata.
#[derive(uniffi::Enum)]
pub enum EstimateFigure {
    Complete { lower: f64, upper: Option<f64> },
    Partial { lower: f64, upper: Option<f64> },
    Unknown,
}

/// A `{ value, unit }` amount as the web renders it (`2 cup`, `3 each`,
/// `2 - 3 tsp`), through the same Rust the web calls as WASM. An empty unit is a
/// bare count: a plain number (`1.5`, not the unit formatter's `1½`).
#[uniffi::export]
pub fn format_amount(unit: String, value: f64, upper_value: Option<f64>) -> String {
    if unit.is_empty() && upper_value.is_none() {
        return recipebridge::format_number_plain(value);
    }
    let unit = if unit.is_empty() {
        "whole".to_string()
    } else {
        unit
    };
    recipebridge::format_amount_labeled(recipebridge::WAmount {
        unit,
        value,
        upper_value,
    })
}

/// An amount multiplied by a recipe scale factor, by the rule web runs as WASM: weight, volume
/// and counts scale, a pan size, oven temperature or rest time does not, and the authored unit
/// spelling is kept.
#[uniffi::export]
pub fn scale_amount(unit: String, value: f64, upper_value: Option<f64>, factor: f64) -> Amount {
    recipebridge::scale_amount(
        recipebridge::WAmount {
            unit,
            value,
            upper_value,
        },
        factor,
    )
    .into()
}

/// A usable scale factor: finite, positive, floored at 0.01; anything else is 1 (unscaled).
#[uniffi::export]
pub fn clamp_scale_factor(factor: f64) -> f64 {
    recipebridge::clamp_scale_factor_value(factor)
}

/// The factor that makes an ingredient's primary amount `new_value` when its unscaled amount is
/// `original_value` (the "make this much of it" anchor).
#[uniffi::export]
pub fn scale_factor_for_ingredient(original_value: f64, new_value: f64) -> f64 {
    recipebridge::scale_factor_for_ingredient_value(original_value, new_value)
}

/// The factor that makes the recipe's total weigh `target_grams` (the "make this much" anchor).
/// `scaled_weight` is the weight as currently displayed (`unscaled x current_factor`), so the
/// target is measured against the original, not compounded on the current scale; an unknown
/// weight (`<= 0`) leaves the recipe unscaled.
#[uniffi::export]
pub fn scale_factor_for_total_weight(
    target_grams: f64,
    scaled_weight: f64,
    current_factor: f64,
) -> f64 {
    recipebridge::scale_factor_for_total_weight_value(target_grams, scaled_weight, current_factor)
}

/// A yield or serving count at `factor`, rounded to two decimals as web does.
#[uniffi::export]
pub fn scale_display_count(value: f64, factor: f64) -> f64 {
    recipebridge::scale_display_count_value(value, factor)
}

/// USD text with grouping and `min..=max` fraction digits (half away from
/// zero); `-$5.00` for a negative, never `+`.
#[uniffi::export]
pub fn format_currency(value: f64, min_fraction_digits: u32, max_fraction_digits: u32) -> String {
    recipebridge::format_currency_usd(value, min_fraction_digits, max_fraction_digits)
}

/// A bare numeric field: the shortest round-trip decimal, no grouping.
#[uniffi::export]
pub fn format_number(value: f64) -> String {
    recipebridge::format_number_plain(value)
}

/// A compact nutrition figure or range without the partial marker (`1,500–2,250`).
#[uniffi::export]
pub fn format_compact_range(lower: f64, upper: Option<f64>, unit: CompactUnit) -> String {
    recipebridge::compact_range_text(lower, upper, unit.into())
}

/// The one-line macro/cost cell: a partial figure ends in `+`, unknown is `—`.
#[uniffi::export]
pub fn format_compact_estimate(figure: EstimateFigure, unit: CompactUnit) -> String {
    let unit = unit.into();
    match figure {
        EstimateFigure::Complete { lower, upper } => {
            recipebridge::compact_range_text(lower, upper, unit)
        }
        EstimateFigure::Partial { lower, upper } => {
            format!("{}+", recipebridge::compact_range_text(lower, upper, unit))
        }
        EstimateFigure::Unknown => "—".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_two_cups_flour() {
        let parsed = parse_ingredient("2 cups flour".to_string());
        assert_eq!(parsed.name, "flour");
        assert!(parsed.display.starts_with("2 "), "{}", parsed.display);
        assert!(parsed.display.ends_with("flour"), "{}", parsed.display);
        assert_eq!(parsed.amounts.len(), 1);
        let amount = &parsed.amounts[0];
        assert_eq!(amount.value, 2.0);
        assert_eq!(amount.unit, "cup");
        assert_eq!(amount.upper_value, None);
        assert_eq!(parsed.modifier, None);
        assert!(!parsed.optional);
    }

    #[test]
    fn display_exports_are_wired_to_the_shared_formatters() {
        // recipebridge's own suite walks every vector; this checks each export is wired to the
        // right function and unit.
        assert_eq!(format_currency(-2.675, 2, 2), "-$2.68");
        assert_eq!(format_number(1234.5678), "1234.5678");
        assert_eq!(format_amount("each".to_string(), 3.0, None), "3 each");
        // A bare count stays a plain number rather than a unit-formatted fraction.
        assert_eq!(format_amount(String::new(), 1.5, None), "1.5");
        assert_eq!(
            format_compact_range(1500.0, Some(2250.4), CompactUnit::Kcal),
            "1,500–2,250"
        );
        assert_eq!(
            format_compact_estimate(
                EstimateFigure::Partial {
                    lower: 5.0,
                    upper: Some(6.5)
                },
                CompactUnit::Macro
            ),
            "5–6.5+"
        );
        assert_eq!(
            format_compact_estimate(EstimateFigure::Unknown, CompactUnit::Kcal),
            "—"
        );
    }

    #[test]
    fn scale_exports_are_wired_to_the_shared_scaling_rules() {
        let flour = scale_amount("cup".to_string(), 2.0, Some(3.0), 1.5);
        assert_eq!((flour.value, flour.upper_value), (3.0, Some(4.5)));
        assert_eq!(flour.unit, "cup");
        // A pan size is not an ingredient quantity: it must not double.
        let pan = scale_amount("inch".to_string(), 9.0, None, 2.0);
        assert_eq!(pan.value, 9.0);
        assert_eq!(clamp_scale_factor(0.0), 1.0);
        assert_eq!(clamp_scale_factor(0.001), 0.01);
        assert_eq!(scale_factor_for_ingredient(2.0, 3.0), 1.5);
        // Displayed at 2x and weighing 800 g, the original is 400 g: 600 g is 1.5x, never 0.75x.
        assert_eq!(scale_factor_for_total_weight(600.0, 800.0, 2.0), 1.5);
        // An unknown weight cannot anchor, so the recipe stays unscaled.
        assert_eq!(scale_factor_for_total_weight(600.0, 0.0, 1.0), 1.0);
        assert_eq!(scale_display_count(4.0, 1.5), 6.0);
    }

    #[test]
    fn size_unit_aliases_are_nonempty_and_cover_oz() {
        let aliases = size_unit_aliases();
        assert!(!aliases.is_empty());
        assert!(
            aliases.iter().any(|alias| alias == "oz"),
            "expected \"oz\" among {aliases:?}"
        );
    }

    #[test]
    fn normalize_isbn_round_trips_isbn10_to_the_stored_gtin14() {
        // `unreachable!` (not `.expect`/`.unwrap`) — this crate denies
        // `clippy::expect_used`/`unwrap_used` with no test-only escape hatch
        // (see recipebridge's, which cubby-ffi deliberately doesn't mirror).
        let Some(normalized) = normalize_isbn("0-306-40615-2".to_string()) else {
            unreachable!("0-306-40615-2 is a known-valid ISBN-10");
        };
        assert_eq!(normalized.isbn13, "9780306406157");
        assert_eq!(normalized.isbn10, Some("0306406152".to_string()));
        assert_eq!(normalized.gtin14, "09780306406157");
    }

    #[test]
    fn normalize_isbn_rejects_a_bad_checksum() {
        assert!(normalize_isbn("0-306-40615-3".to_string()).is_none());
    }

    #[test]
    fn scan_code_gtin14_prefers_isbn_identity_over_a_plain_barcode_pad() {
        assert_eq!(
            scan_code_gtin14("0-306-40615-2".to_string()),
            Some("09780306406157".to_string())
        );
        assert_eq!(
            scan_code_gtin14("012345678905".to_string()),
            Some("00012345678905".to_string())
        );
        assert_eq!(scan_code_gtin14("not a code".to_string()), None);
    }
}
