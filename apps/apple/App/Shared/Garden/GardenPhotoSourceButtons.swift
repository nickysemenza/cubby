import CubbyKit
import SwiftUI

/// Selection does no subject lifting; the Garden upload path preserves the whole scene.
struct GardenPhotoSourceButtons: View {
    let onImages: ([CGImage]) -> Void
    var body: some View { PhotoSourceButtons(maxSelectionCount: 12, onImages: onImages) }
}

#Preview { GardenPhotoSourceButtons { _ in }.padding().porcelainScreen() }
