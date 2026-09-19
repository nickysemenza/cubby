import CubbyKit
import Foundation

@testable import Cubby

/// One shared in-memory `PhotoAnalysisStore` for every `PhotoImportManifest` test fixture in this
/// target, instead of `PhotoImportManifest.init`'s own default (a fresh `ModelContainer` per
/// manifest). SwiftData's `ModelContainer` construction has been observed to crash under
/// concurrently-running tests — `CubbyKitTests.PhotoAnalysisStoreTests` documents the same failure
/// and works around it with `.serialized`, which only orders tests *inside* one suite. Swift
/// Testing still runs that suite in parallel with `PhotoImportFlowTests` and
/// `PhotoDestinationOptionTests`, both of which build a manifest per test, so the race was still
/// live for them. Sharing one store built once removes it instead of serializing more suites.
enum PhotoTestStores {
    @MainActor static let shared: PhotoAnalysisStore = try! PhotoAnalysisStore.make(inMemory: true)
}

/// Every `PhotoImportManifest` test fixture goes through this instead of calling the initializer
/// directly, so all of them share `PhotoTestStores.shared`.
@MainActor
func makeManifest(items: [PhotoSelectionItem]) -> PhotoImportManifest {
    PhotoImportManifest(items: items, analysisStore: PhotoTestStores.shared)
}
