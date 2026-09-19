#if canImport(Vision)
    import Testing
    import Vision

    @testable import CubbyKit

    /// `PhotoImportCatalog.categories` (generated from `packages/schemas/src/photo-categories.ts` —
    /// see `scripts/generator/entities/render/image-policy.ts`) declares every category's *effective*
    /// classifier labels: its base vocabulary plus every member entity's own `classifierLabels`. A
    /// label Vision's on-device classifier does not recognize can never fire, so a typo on either side
    /// would silently never match — this asserts every effective label is one Vision actually emits.
    @Suite("PhotoCategoryClassifierLabels")
    struct PhotoCategoryClassifierLabelsTests {
        // `ClassifyImageRequest` needs iOS 18 / macOS 15 (Package.swift already declares iOS/macOS 26
        // as CubbyKit's floor, so this is always satisfied today); the `@available` guard lets Swift
        // Testing skip this test cleanly instead of failing to build if that floor is ever lowered.
        @Test
        @available(iOS 18, macOS 15, tvOS 18, visionOS 2, *)
        func everyCategorysEffectiveLabelsAreVisionSupported() {
            let supported = Set(ClassifyImageRequest().supportedIdentifiers)
            for category in PhotoImportCatalog.categories {
                let unsupported = category.classifierLabels.filter { !supported.contains($0) }
                #expect(
                    unsupported.isEmpty,
                    "photoCategories.\(category.key) has classifierLabels outside Vision's taxonomy: \(unsupported)"
                )
            }
        }
    }
#endif
