import CubbyKit
import SwiftUI

/// Record overview and actions remain native; complex workspaces share the web UI.
struct RunEvidenceLink: View {
    let runID: String
    @State private var showing = false
    var body: some View {
        Button("Transcript, logs and AI usage", systemImage: "doc.text.magnifyingglass") { showing = true }
            .sheet(isPresented: $showing) {
                NavigationStack { RunEvidenceView(runID: runID) }
            }
    }
}

struct RunEvidenceView: View {
    let runID: String
    var body: some View { HostedWorkspaceView(surface: .runEvidence(runID), title: "Run evidence") }
}
