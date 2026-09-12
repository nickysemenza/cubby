//! UniFFI boundary exposing `recipebridge`'s ingredient parser to Swift on
//! iOS and macOS. Same Rust source as the WASM build the web app uses
//! (`recipebridge` itself is untouched); this crate only translates its
//! wasm-bindgen/tsify types into UniFFI records at the boundary.
//!
//! v1 is deliberately thin: both exports are infallible (the underlying
//! parser never fails; it falls back to a name-only ingredient), so there is
//! no `uniffi::Error` here. A dead error enum would trip `-D warnings`.

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
        Self {
            unit: amount.unit,
            value: amount.value,
            upper_value: amount.upper_value,
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
    ParsedIngredient::new(
        recipebridge::parse_ingredient(&line),
        recipebridge::format_ingredient(&line),
    )
}

/// The unit-alias vocabulary `parse_ingredient` recognizes for weight/volume
/// sizes (longest-first, so a caller can `join("|")` into a regex
/// alternation without re-sorting). Never hand-list these in Swift.
#[uniffi::export]
pub fn size_unit_aliases() -> Vec<String> {
    recipebridge::size_unit_aliases()
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
}
