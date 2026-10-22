/// Mirrors `recipebridge::NormalizedIsbn` (`isbn13`, `isbn10`, `gtin14`) at the
/// UniFFI boundary, exhaustively destructured for the same reason `Amount`
/// is: a field added in recipebridge fails this to compile instead of
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

/// Recognize an ISBN from canonical storage using recipebridge's validated rule.
#[uniffi::export]
pub fn isbn_from_gtin(value: String) -> Option<NormalizedIsbn> {
    recipebridge::isbn_from_gtin(&value).map(NormalizedIsbn::from)
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
    fn normalize_isbn_round_trips_isbn10_to_the_stored_gtin14() {
        // `unreachable!` (not `.expect`/`.unwrap`): this crate's tests keep the
        // workspace's `expect_used`/`unwrap_used` deny, unlike recipebridge's.
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
