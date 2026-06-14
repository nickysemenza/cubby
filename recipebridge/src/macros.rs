//! Small internal macros for the wasm boundary layer.

/// Generate a `W*` mirror enum plus an exhaustive `From<upstream>` conversion.
///
/// The wrapper exists because the orphan rule forbids `#[derive(Tsify)]` on the
/// upstream enum, and the generated `From` match is the **compile-time drift
/// tripwire**: it stays exhaustive, so adding a variant upstream fails to compile
/// here until it's mirrored. Wrapper variant names must match the upstream
/// variant names 1:1.
///
/// ```ignore
/// mirror_enum! {
///     /// docs…
///     #[tsify(into_wasm_abi)]
///     #[serde(rename_all = "snake_case")]
///     pub enum WIngredientUsage <= IngredientUsage { Normal, FryingMedium }
/// }
/// ```
macro_rules! mirror_enum {
    (
        $(#[$attr:meta])*
        $vis:vis enum $W:ident <= $Up:path { $($variant:ident),+ $(,)? }
    ) => {
        // Derive first: the caller's `#[serde(...)]` / `#[tsify(...)]` are helper
        // attributes of these derives and must appear after them.
        #[derive(
            ::tsify_next::Tsify,
            ::serde::Serialize,
            ::serde::Deserialize,
            Clone, Copy, PartialEq, Eq, Debug,
        )]
        $(#[$attr])*
        $vis enum $W { $($variant),+ }

        impl From<$Up> for $W {
            fn from(u: $Up) -> Self {
                match u { $( <$Up>::$variant => Self::$variant, )+ }
            }
        }
    };
}
