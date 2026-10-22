/// Mirrors `recipebridge::WAmount` (`unit`, `value`, `upper_value`) at the
/// UniFFI boundary, both ways: parsed amounts come out as it and
/// `scale_amount` takes it back in.
#[derive(uniffi::Record)]
pub struct Amount {
    pub unit: String,
    pub value: f64,
    pub upper_value: Option<f64>,
}

impl From<recipebridge::WAmount> for Amount {
    fn from(amount: recipebridge::WAmount) -> Self {
        // Exhaustive destructure (no `..`): a field added to `WAmount` fails this
        // to compile instead of silently being dropped from the FFI boundary.
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

impl From<Amount> for recipebridge::WAmount {
    fn from(amount: Amount) -> Self {
        let Amount {
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

/// A reduced projection of `recipebridge::WIngredient`: `usage` and
/// `parse_notes` are review/classification metadata the native client does not
/// consume yet, so they stay off the FFI surface until a screen needs them.
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
    // One parse for both the structured result and the display string, rather
    // than `parse_ingredient` and `format_ingredient` each parsing the line.
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
