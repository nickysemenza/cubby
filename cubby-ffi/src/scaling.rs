use crate::Amount;

/// An amount multiplied by a recipe scale factor, by the rule web runs as WASM: weight, volume
/// and counts scale, a pan size, oven temperature or rest time does not, and the authored unit
/// spelling is kept.
#[uniffi::export]
pub fn scale_amount(amount: Amount, factor: f64) -> Amount {
    recipebridge::scale_amount(amount.into(), factor).into()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn amount(unit: &str, value: f64, upper_value: Option<f64>) -> Amount {
        Amount {
            unit: unit.to_string(),
            value,
            upper_value,
        }
    }

    #[test]
    fn scale_exports_are_wired_to_the_shared_scaling_rules() {
        let flour = scale_amount(amount("cup", 2.0, Some(3.0)), 1.5);
        assert_eq!((flour.value, flour.upper_value), (3.0, Some(4.5)));
        assert_eq!(flour.unit, "cup");
        // A pan size is not an ingredient quantity: it must not double.
        let pan = scale_amount(amount("inch", 9.0, None), 2.0);
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
}
