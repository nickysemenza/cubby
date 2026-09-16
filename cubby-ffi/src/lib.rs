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
