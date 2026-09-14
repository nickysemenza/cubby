import CubbyKit
import SwiftUI

/// Selection does no subject lifting; the Garden upload path preserves the whole scene.
struct GardenPhotoSourceButtons: View {
    let onItems: ([PhotoSelectionItem]) -> Void
    let maxSelectionCount: Int

    init(maxSelectionCount: Int = 12, onItems: @escaping ([PhotoSelectionItem]) -> Void) {
        self.maxSelectionCount = min(maxSelectionCount, 12)
        self.onItems = onItems
    }

    var body: some View {
        if maxSelectionCount > 0 {
            PhotoSourceButtons(maxSelectionCount: maxSelectionCount, onSelection: onItems)
        }
    }
}

#Preview { GardenPhotoSourceButtons { _ in }.padding().porcelainScreen() }
