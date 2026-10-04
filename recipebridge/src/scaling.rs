//! Recipe scaling arithmetic shared by web (wasm) and native (UniFFI): how a scale
//! anchor resolves to one factor, and how a scaled count (yield, servings) is
//! rounded for display. Per-amount scaling is `scale_amount` in [`crate::conversion`].
//!
//! Web and Swift call these instead of clamping and rounding themselves, so a
//! "double it" anchor, a "make 600 g" anchor and a "this much butter" anchor
//! land on the same factor everywhere.

use wasm_bindgen::prelude::*;

/// Below this the recipe is effectively zeroed out; a stray `0` or blank input must
/// not wipe every amount or divide by zero.
pub const MIN_SCALE_FACTOR: f64 = 0.01;

/// A usable factor: finite, positive, and at least [`MIN_SCALE_FACTOR`]; anything
/// else is the unscaled `1`.
pub fn clamp_scale_factor_value(factor: f64) -> f64 {
    if factor.is_finite() && factor > 0.0 {
        factor.max(MIN_SCALE_FACTOR)
    } else {
        1.0
    }
}

/// The factor that makes the recipe's total weigh `target_grams`. `scaled_weight`
/// is the weight of the recipe as currently displayed (`unscaled x current_factor`),
/// so the target is measured against the original rather than compounding on it.
/// Unknown weight (`<= 0`) or a nonsensical current factor leaves the recipe unscaled.
pub fn scale_factor_for_total_weight_value(
    target_grams: f64,
    scaled_weight: f64,
    current_factor: f64,
) -> f64 {
    if scaled_weight > 0.0 && current_factor > 0.0 {
        let unscaled_weight = scaled_weight / current_factor;
        clamp_scale_factor_value(target_grams / unscaled_weight)
    } else {
        1.0
    }
}

/// The factor that makes one ingredient's primary amount `new_value`, given its
/// unscaled `original_value`. A missing or non-positive original cannot anchor.
pub fn scale_factor_for_ingredient_value(original_value: f64, new_value: f64) -> f64 {
    if original_value > 0.0 {
        clamp_scale_factor_value(new_value / original_value)
    } else {
        1.0
    }
}

/// A yield or serving count times `factor`, rounded to two decimals (half up) to
/// strip float noise; per-serving figures stay invariant because both sides scale.
pub fn scale_display_count_value(value: f64, factor: f64) -> f64 {
    (value * factor * 100.0 + 0.5).floor() / 100.0
}

#[wasm_bindgen]
pub fn clamp_scale_factor(factor: f64) -> f64 {
    clamp_scale_factor_value(factor)
}

#[wasm_bindgen]
pub fn scale_factor_for_total_weight(
    target_grams: f64,
    scaled_weight: f64,
    current_factor: f64,
) -> f64 {
    scale_factor_for_total_weight_value(target_grams, scaled_weight, current_factor)
}

#[wasm_bindgen]
pub fn scale_factor_for_ingredient(original_value: f64, new_value: f64) -> f64 {
    scale_factor_for_ingredient_value(original_value, new_value)
}

#[wasm_bindgen]
pub fn scale_display_count(value: f64, factor: f64) -> f64 {
    scale_display_count_value(value, factor)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_keeps_a_usable_factor_and_floors_a_tiny_one() {
        assert_eq!(clamp_scale_factor_value(2.5), 2.5);
        assert_eq!(clamp_scale_factor_value(0.001), MIN_SCALE_FACTOR);
    }

    #[test]
    fn clamp_falls_back_to_unscaled_for_unusable_input() {
        for bad in [0.0, -3.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(clamp_scale_factor_value(bad), 1.0, "{bad}");
        }
    }

    #[test]
    fn total_weight_anchor_measures_against_the_unscaled_recipe() {
        // Displayed at 2x and weighing 800 g, so the original is 400 g: 600 g is 1.5x,
        // not 0.75x (which compounding on the displayed weight would give).
        assert_eq!(scale_factor_for_total_weight_value(600.0, 800.0, 2.0), 1.5);
    }

    #[test]
    fn total_weight_anchor_without_a_weight_is_unscaled() {
        assert_eq!(scale_factor_for_total_weight_value(600.0, 0.0, 1.0), 1.0);
        assert_eq!(scale_factor_for_total_weight_value(600.0, 400.0, 0.0), 1.0);
        assert_eq!(
            scale_factor_for_total_weight_value(600.0, f64::NAN, 1.0),
            1.0
        );
    }

    #[test]
    fn ingredient_anchor_is_the_ratio_to_the_original_amount() {
        assert_eq!(scale_factor_for_ingredient_value(2.0, 3.0), 1.5);
        // A zero target is unusable, so clamping falls back to unscaled.
        assert_eq!(scale_factor_for_ingredient_value(2.0, 0.0), 1.0);
    }

    #[test]
    fn ingredient_anchor_needs_a_positive_original() {
        assert_eq!(scale_factor_for_ingredient_value(0.0, 3.0), 1.0);
        assert_eq!(scale_factor_for_ingredient_value(-1.0, 3.0), 1.0);
        assert_eq!(scale_factor_for_ingredient_value(f64::NAN, 3.0), 1.0);
    }

    #[test]
    fn scaled_counts_round_half_up_to_two_decimals() {
        assert_eq!(scale_display_count_value(4.0, 1.5), 6.0);
        assert_eq!(scale_display_count_value(3.0, 1.0 / 3.0), 1.0);
        assert_eq!(scale_display_count_value(1.0, 0.125), 0.13);
        assert_eq!(scale_display_count_value(0.1, 3.0), 0.3);
    }
}
