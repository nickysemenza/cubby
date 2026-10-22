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

/// A nutrition/cost estimate as the display formatters read it: mirrors
/// `recipebridge::WMeasureEstimate` without the coverage counts no label prints.
#[derive(uniffi::Enum)]
pub enum EstimateFigure {
    Complete {
        lower: f64,
        upper: Option<f64>,
        inferred_zero: u32,
    },
    Partial {
        lower: f64,
        upper: Option<f64>,
        inferred_zero: u32,
    },
    Unavailable {
        not_applicable: bool,
    },
    Pending,
}

impl From<EstimateFigure> for recipebridge::WMeasureEstimate {
    fn from(figure: EstimateFigure) -> Self {
        let coverage = |inferred_zero| recipebridge::WEstimateCoverage {
            covered: 0,
            total: 0,
            inferred_zero,
        };
        match figure {
            EstimateFigure::Complete {
                lower,
                upper,
                inferred_zero,
            } => Self::Complete {
                lower,
                upper,
                coverage: coverage(inferred_zero),
            },
            EstimateFigure::Partial {
                lower,
                upper,
                inferred_zero,
            } => Self::Partial {
                lower,
                upper,
                coverage: coverage(inferred_zero),
            },
            EstimateFigure::Unavailable { not_applicable } => Self::Unavailable {
                reason: if not_applicable {
                    recipebridge::WUnavailableReason::NotApplicable
                } else {
                    recipebridge::WUnavailableReason::NoData
                },
                coverage: None,
            },
            EstimateFigure::Pending => Self::Pending {
                reason: recipebridge::WPendingReason::TotalsMissing,
            },
        }
    }
}

/// Which number rule a long-form estimate label uses; mirrors
/// `recipebridge::WEstimateMeasure`.
#[derive(uniffi::Enum)]
pub enum EstimateMeasure {
    Cost,
    Kcal,
    Macro,
    Share,
}

impl From<EstimateMeasure> for recipebridge::WEstimateMeasure {
    fn from(measure: EstimateMeasure) -> Self {
        match measure {
            EstimateMeasure::Cost => Self::Cost,
            EstimateMeasure::Kcal => Self::Kcal,
            EstimateMeasure::Macro => Self::Macro,
            EstimateMeasure::Share => Self::Share,
        }
    }
}

/// A `{ value, unit }` amount as the web renders it (`2 cup`, `3 each`,
/// `2 - 3 tsp`, a bare count `1.5`), through the same Rust the web calls as WASM.
#[uniffi::export]
pub fn format_amount(unit: String, value: f64, upper_value: Option<f64>) -> String {
    recipebridge::format_amount_labeled(recipebridge::WAmount {
        unit,
        value,
        upper_value,
    })
}

/// USD text with grouping and `min..=max` fraction digits (half away from
/// zero); `-$5.00` for a negative, never `+`.
#[uniffi::export]
pub fn format_currency(value: f64, min_fraction_digits: u32, max_fraction_digits: u32) -> String {
    recipebridge::format_currency(value, min_fraction_digits, max_fraction_digits)
}

/// A bare numeric field: the shortest round-trip decimal, no grouping.
#[uniffi::export]
pub fn format_number(value: f64) -> String {
    recipebridge::format_number(value)
}

/// The one-line macro/cost cell: a partial figure ends in `+`, unknown is `—`.
#[uniffi::export]
pub fn format_compact_estimate(figure: EstimateFigure, unit: CompactUnit) -> String {
    recipebridge::format_compact_estimate(figure.into(), unit.into())
}

/// The long-form estimate label (`420 kcal known · partial`, `Pending`, `N/A`).
#[uniffi::export]
pub fn format_estimate(
    figure: EstimateFigure,
    measure: EstimateMeasure,
    unit: Option<String>,
) -> String {
    recipebridge::format_estimate(figure.into(), measure.into(), unit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_exports_are_wired_to_the_shared_formatters() {
        // recipebridge's own suite walks every vector; this checks each export is wired to the
        // right function and unit.
        assert_eq!(format_currency(-2.675, 2, 2), "-$2.68");
        assert_eq!(format_number(1234.5678), "1234.5678");
        assert_eq!(format_amount("each".to_string(), 3.0, None), "3 each");
        assert_eq!(
            format_compact_estimate(
                EstimateFigure::Partial {
                    lower: 5.0,
                    upper: Some(6.5),
                    inferred_zero: 0,
                },
                CompactUnit::Macro
            ),
            "5–6.5+"
        );
        assert_eq!(
            format_compact_estimate(EstimateFigure::Pending, CompactUnit::Kcal),
            "—"
        );
        assert_eq!(
            format_estimate(
                EstimateFigure::Partial {
                    lower: 1500.0,
                    upper: Some(2250.4),
                    inferred_zero: 0,
                },
                EstimateMeasure::Kcal,
                Some("kcal".to_string())
            ),
            "1,500–2,250 kcal known · partial"
        );
        assert_eq!(
            format_estimate(
                EstimateFigure::Unavailable {
                    not_applicable: true
                },
                EstimateMeasure::Macro,
                None
            ),
            "N/A"
        );
        assert_eq!(
            format_estimate(EstimateFigure::Pending, EstimateMeasure::Cost, None),
            "Pending"
        );
    }
}
