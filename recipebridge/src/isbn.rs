//! ISBN identity: validate ISBN-10/ISBN-13 check digits and normalize either
//! encoding to the single GTIN-14 identity Cubby stores.
//!
//! Ported from the deleted `packages/schemas/src/isbn.ts` (see
//! `packages/schemas/src/isbn.unit.test.ts`'s former golden cases, now inline
//! below) so both the web (via wasm) and the native app (via `cubby-ffi`,
//! which calls these `pub fn`s directly — a `#[wasm_bindgen]` function stays
//! a plain callable Rust item off wasm32) read the exact same check-digit
//! logic. `packages/schemas` cannot depend on this crate (no WASM in that
//! package), so callers there now validate at the repository boundary
//! instead — see `apps/web/src/server/repo/product/update-helpers.ts`'s
//! `requireCanonicalIsbn`.

use serde::{Deserialize, Serialize};
use tsify_next::Tsify;
use wasm_bindgen::prelude::*;

/// The single ISBN identity Cubby stores (mirrors the deleted TS
/// `NormalizedIsbn`). `isbn10` exists only for the original 978 registration
/// group — ISBN-13s outside it (979-*) have no ISBN-10 equivalent.
#[derive(Tsify, Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[tsify(into_wasm_abi)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedIsbn {
    pub isbn13: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional, type = "string | null")]
    pub isbn10: Option<String>,
    pub gtin14: String,
}

/// Strip whitespace and hyphens, uppercase (for a trailing ISBN-10 `x` check
/// digit). Mirrors `compactIsbn` in the deleted TS.
fn compact_isbn(value: &str) -> String {
    value
        .trim()
        .to_uppercase()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect()
}

/// ISBN-13 check digit over the first 12 digits (alternating x1/x3 weights).
/// `first_twelve` is expected to be 12 ASCII digits; a caller that violates
/// that gets a well-defined (if meaningless) digit back rather than a panic.
fn isbn13_check_digit(first_twelve: &str) -> char {
    let sum: u32 = first_twelve
        .chars()
        .enumerate()
        .map(|(i, c)| c.to_digit(10).unwrap_or(0) * if i % 2 == 0 { 1 } else { 3 })
        .sum();
    // `(10 - sum % 10) % 10` is always in 0..=9, so `from_digit` never fails;
    // the fallback is unreachable, not a real error path.
    char::from_digit((10 - sum % 10) % 10, 10).unwrap_or('0')
}

/// ISBN-10 check digit over the first 9 digits (descending x10..x2 weights,
/// remainder 10 prints as `X`). Mirrors `isbn10CheckDigit` in the deleted TS.
fn isbn10_check_digit(first_nine: &str) -> String {
    let sum: u32 = first_nine
        .chars()
        .enumerate()
        .map(|(i, c)| c.to_digit(10).unwrap_or(0) * (10 - i as u32))
        .sum();
    let remainder = (11 - sum % 11) % 11;
    if remainder == 10 {
        "X".to_string()
    } else {
        remainder.to_string()
    }
}

/// `/^\d{9}[\dX]$/` plus the check digit.
fn is_valid_isbn10(value: &str) -> bool {
    if value.len() != 10 {
        return false;
    }
    let (first_nine, last) = value.split_at(9);
    if !first_nine.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    if last != "X" && !last.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    isbn10_check_digit(first_nine) == last
}

/// 978, or 979 excluding 979-0 (ISMN, printed music -- not ISBN).
fn is_bookland_prefix(value: &str) -> bool {
    value.starts_with("978") || (value.starts_with("979") && !value.starts_with("9790"))
}

/// `/^\d{13}$/` plus the Bookland prefix and check digit.
fn is_valid_isbn13(value: &str) -> bool {
    if value.len() != 13 || !value.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    if !is_bookland_prefix(value) {
        return false;
    }
    let (first_twelve, last) = value.split_at(12);
    isbn13_check_digit(first_twelve).to_string() == last
}

/// `isbn13` is already-validated 13 ASCII digits (every caller below checked
/// `is_valid_isbn13` first), so the byte slicing here can't land mid-codepoint.
fn from_isbn13(isbn13: &str) -> NormalizedIsbn {
    let isbn10 = isbn13.starts_with("978").then(|| {
        let middle = &isbn13[3..12];
        format!("{middle}{}", isbn10_check_digit(middle))
    });
    NormalizedIsbn {
        isbn13: isbn13.to_string(),
        isbn10,
        gtin14: format!("{isbn13:0>14}"),
    }
}

/// Validate either ISBN encoding and return the single identity Cubby stores.
///
/// ISBN-13 is an EAN/GTIN. ISBN-10 is converted to its ISBN-13 equivalent
/// before storage, so a title cannot acquire two external-id rows merely
/// because two callers used different printed encodings.
#[wasm_bindgen]
pub fn normalize_isbn(value: &str) -> Option<NormalizedIsbn> {
    let compact = compact_isbn(value);
    // Every subsequent branch slices `compact` at byte offsets computed from
    // ASCII-only lengths (9, 12, 13, 14) -- safe only because `compact` is
    // confirmed pure ASCII first, so no slice can land mid-codepoint even for
    // wildly non-ASCII garbage input.
    if !compact.is_ascii() {
        return None;
    }
    if compact.len() == 14 && compact.starts_with('0') && is_valid_isbn13(&compact[1..]) {
        return Some(from_isbn13(&compact[1..]));
    }
    if is_valid_isbn10(&compact) {
        let first_twelve = format!("978{}", &compact[..9]);
        let check_digit = isbn13_check_digit(&first_twelve);
        return Some(from_isbn13(&format!("{first_twelve}{check_digit}")));
    }
    if is_valid_isbn13(&compact) {
        return Some(from_isbn13(&compact));
    }
    None
}

/// Derive the ISBN identity from a stored GTIN-14 (the `0` + ISBN-13 shape
/// every ISBN is persisted as).
#[wasm_bindgen]
pub fn isbn_from_gtin(value: &str) -> Option<NormalizedIsbn> {
    if value.len() != 14 || !value.starts_with('0') || !value.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    normalize_isbn(&value[1..])
}

/// Pick the ISBN out of an EPUB's raw OPF `<dc:identifier>` values.
///
/// A book usually declares several in different schemes, and the OPF's own
/// `unique-identifier` attribute frequently names a Calibre UUID rather than
/// the ISBN -- so this scans all of them rather than trusting declaration
/// order. Scheme prefixes (`urn:isbn:`, `ISBN:`) are stripped before
/// validation, and validation is [`normalize_isbn`]'s: a `urn:uuid:` value has
/// no chance of passing an ISBN check digit, which is what makes scanning
/// everything safe.
///
/// Returns the canonical GTIN-14, matching how barcodes are stored, or `None`
/// when the book declares no ISBN at all (common for EPUBs built from web
/// sources).
#[wasm_bindgen]
pub fn isbn_from_epub_identifiers(identifiers: Vec<String>) -> Option<String> {
    identifiers
        .iter()
        .find_map(|raw| normalize_isbn(&strip_isbn_scheme(raw)).map(|n| n.gtin14))
}

/// Strip a leading `urn:isbn:` or `isbn:` scheme prefix (case-insensitive),
/// after trimming. `lower`'s ASCII-only case fold keeps it the same byte
/// length as `trimmed`, so slicing `trimmed` at `rest`'s length is safe.
fn strip_isbn_scheme(raw: &str) -> String {
    let trimmed = raw.trim();
    let lower = trimmed.to_ascii_lowercase();
    for prefix in ["urn:isbn:", "isbn:"] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            return trimmed[trimmed.len() - rest.len()..].to_string();
        }
    }
    trimmed.to_string()
}

/// Search spellings for a stored book barcode. The canonical GTIN remains
/// first so callers that do not care about books preserve their existing
/// behavior.
#[wasm_bindgen]
pub fn product_code_search_terms(value: &str) -> Vec<String> {
    let normalized = isbn_from_gtin(value).or_else(|| normalize_isbn(value));
    match normalized {
        None => vec![value.to_string()],
        Some(n) => {
            let mut terms = vec![n.gtin14, n.isbn13];
            if let Some(isbn10) = n.isbn10 {
                terms.push(isbn10);
            }
            terms
        }
    }
}

/// Classify a raw scanner code as a GTIN-14: a valid ISBN-10/ISBN-13 (per
/// [`normalize_isbn`]) normalizes to its `gtin14`; otherwise a compact
/// all-digit string of a plausible barcode length (8/12/13/14, matching
/// EAN-8/UPC-A/EAN-13/GTIN-14) is zero-padded to 14. Anything else -- letters,
/// the wrong digit count, empty input -- is `None`.
#[wasm_bindgen]
pub fn scan_code_gtin14(raw: &str) -> Option<String> {
    if let Some(normalized) = normalize_isbn(raw) {
        return Some(normalized.gtin14);
    }
    let compact = compact_isbn(raw);
    if matches!(compact.len(), 8 | 12 | 13 | 14) && compact.chars().all(|c| c.is_ascii_digit()) {
        return Some(format!("{compact:0>14}"));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn normalized(isbn13: &str, isbn10: Option<&str>, gtin14: &str) -> NormalizedIsbn {
        NormalizedIsbn {
            isbn13: isbn13.to_string(),
            isbn10: isbn10.map(str::to_string),
            gtin14: gtin14.to_string(),
        }
    }

    #[test]
    fn normalizes_isbn10_and_isbn13_to_one_gtin14() {
        let from_ten = normalize_isbn("0-306-40615-2");
        let from_thirteen = normalize_isbn("978-0-306-40615-7");
        let expected = normalized("9780306406157", Some("0306406152"), "09780306406157");

        assert_eq!(from_ten, Some(expected.clone()));
        assert_eq!(from_thirteen, Some(expected));
    }

    /// The regression this guards: re-normalizing an already-canonical GTIN14
    /// must be a no-op, or a value round-tripping through storage would drift.
    #[test]
    fn renormalizing_a_canonical_gtin_is_idempotent() {
        let once = normalize_isbn("0-306-40615-2").expect("valid isbn10");
        let twice = normalize_isbn(&once.gtin14).expect("valid gtin14");
        assert_eq!(once, twice);
    }

    #[test]
    fn derives_isbn_search_aliases_from_a_stored_gtin() {
        assert_eq!(
            isbn_from_gtin("09780306406157").map(|n| n.isbn13),
            Some("9780306406157".to_string())
        );
        assert_eq!(
            product_code_search_terms("09780306406157"),
            vec!["09780306406157", "9780306406157", "0306406152"]
        );
    }

    #[test]
    fn accepts_979_isbns_without_inventing_an_isbn10() {
        assert_eq!(
            normalize_isbn("979-10-90636-07-1"),
            Some(normalized("9791090636071", None, "09791090636071")),
        );
    }

    #[test]
    fn rejects_bad_checksums_and_the_979_0_ismn_namespace() {
        assert_eq!(normalize_isbn("0-306-40615-3"), None);
        assert_eq!(normalize_isbn("9780306406158"), None);
        assert_eq!(normalize_isbn("979-0-060-11561-5"), None);
    }

    #[test]
    fn does_not_reinterpret_an_arbitrary_barcode_as_an_isbn() {
        assert_eq!(
            product_code_search_terms("00012345678905"),
            vec!["00012345678905"]
        );
    }

    /// A Calibre-produced EPUB declares the UUID first and names IT as the
    /// OPF's `unique-identifier`, so trusting declaration order or that
    /// attribute would pick the wrong value on the most common kind of book
    /// in the library.
    #[test]
    fn finds_the_isbn_behind_a_leading_calibre_uuid() {
        assert_eq!(
            isbn_from_epub_identifiers(vec![
                "urn:uuid:6f2b1a30-1f1e-4f6a-9d5a-000000000000".to_string(),
                "urn:isbn:9781579656317".to_string(),
            ]),
            Some("09781579656317".to_string())
        );
    }

    #[test]
    fn strips_either_scheme_prefix_and_accepts_a_bare_isbn() {
        assert_eq!(
            isbn_from_epub_identifiers(vec!["ISBN:978-1-57965-631-7".to_string()]),
            Some("09781579656317".to_string())
        );
        assert_eq!(
            isbn_from_epub_identifiers(vec!["9781579656317".to_string()]),
            Some("09781579656317".to_string())
        );
    }

    /// ISBN-10 normalizes to the same identity, so a book can't acquire a
    /// second Product merely because its EPUB printed the older encoding.
    #[test]
    fn normalizes_an_isbn10_epub_identifier_to_the_same_gtin14_as_its_isbn13() {
        assert_eq!(
            isbn_from_epub_identifiers(vec!["0306406152".to_string()]),
            Some("09780306406157".to_string())
        );
    }

    /// The reason scanning every identifier is safe: nothing that isn't an
    /// ISBN can pass the check digit, so a UUID-only book yields `None`
    /// rather than a wrong match that would link the cookbook to some
    /// unrelated product.
    #[test]
    fn returns_none_when_no_identifier_is_a_valid_isbn() {
        assert_eq!(
            isbn_from_epub_identifiers(vec![
                "urn:uuid:6f2b1a30-1f1e-4f6a-9d5a-000000000000".to_string(),
                "calibre:1234".to_string(),
                "9780306406158".to_string(),
            ]),
            None
        );
        assert_eq!(isbn_from_epub_identifiers(vec![]), None);
    }

    #[test]
    fn scan_code_gtin14_prefers_isbn_identity() {
        assert_eq!(
            scan_code_gtin14("0-306-40615-2"),
            Some("09780306406157".to_string())
        );
        assert_eq!(
            scan_code_gtin14("9780306406157"),
            Some("09780306406157".to_string())
        );
    }

    #[test]
    fn scan_code_gtin14_pads_a_plain_barcode() {
        assert_eq!(
            scan_code_gtin14("012345678905"),
            Some("00012345678905".to_string())
        );
        assert_eq!(
            scan_code_gtin14("12345678"),
            Some("00000012345678".to_string())
        );
    }

    #[test]
    fn scan_code_gtin14_rejects_non_codes() {
        assert_eq!(scan_code_gtin14("abc"), None);
        assert_eq!(scan_code_gtin14(""), None);
    }
}
