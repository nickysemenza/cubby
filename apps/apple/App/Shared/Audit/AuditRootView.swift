import CubbyKit
import SwiftUI

/// Placeholder until the recount session lands; keeps `Route.audit` resolvable.
struct AuditRootView: View {
    let locationID: LocationCode?

    var body: some View {
        Text("Walk the shelf")
            .porcelainScreen()
            .navigationTitle("Audit")
    }
}
