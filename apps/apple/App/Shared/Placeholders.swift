import CubbyKit
import SwiftUI

// Placeholder screens so the app builds before the Identify and Dev steps land.
// Each gets replaced by its real view in its own file; delete the placeholder when that happens.

struct IdentifyView: View {
    var body: some View {
        ContentUnavailableView("Identify", systemImage: "camera.metering.center.weighted", description: Text("Feature-print matching lands in a later step."))
            .navigationTitle("Identify")
    }
}
