import CubbyKit
import Foundation

@testable import Cubby

/// One shared in-memory `PhotoAnalysisStore` for every `PhotoImportManifest` test fixture in this
/// target, rather than building a database per fixture. It keeps manifest tests fast while each
/// test still gets isolated records through its unique fixture identifiers.
enum PhotoTestStores {
    @MainActor static let shared: PhotoAnalysisStore = try! PhotoAnalysisStore.make(inMemory: true)
}

/// Every `PhotoImportManifest` test fixture goes through this instead of calling the initializer
/// directly, so all of them share `PhotoTestStores.shared`.
@MainActor
func makeManifest(items: [PhotoSelectionItem]) -> PhotoImportManifest {
    PhotoImportManifest(items: items, analysisStore: PhotoTestStores.shared)
}
