import CubbyKit
import SwiftUI

/// Placeholder until the photo queue lands; keeps `Route.needsPhoto` resolvable.
struct NeedsPhotoView: View {
    let locationID: LocationCode?

    var body: some View {
        Text("Needs a photo")
            .porcelainScreen()
            .navigationTitle("Needs a photo")
    }
}
