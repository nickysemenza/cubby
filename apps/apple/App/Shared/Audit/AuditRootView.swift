import CryptoKit
import CubbyKit
import SwiftUI

/// The walk-the-shelf audit: one `RecountSession` driving a scope picker, then a pass over every
/// stocked bin, then a summary. `locationID` pre-scopes the walk when it arrives from a deep link
/// or the Capture screen's shortcut.
struct AuditRootView: View {
    let locationID: LocationCode?

    @Environment(AppModel.self) private var model
    @State private var session: RecountSession?

    private var persistenceNamespace: String {
        let credentialKey: String
        switch model.credential {
        case .some(.bearer(let token)), .some(.apiKey(let token)): credentialKey = token
        case nil: credentialKey = "signed-out"
        }
        let digest = SHA256.hash(data: Data(credentialKey.utf8))
            .map { String(format: "%02x", $0) }.joined()
        return "\(model.host).\(digest)"
    }

    var body: some View {
        Group {
            if let session {
                AuditPhaseView(session: session)
            } else {
                LoadingIndicator.screen(label: "Loading walk the shelf")
            }
        }
        .fieldGuideScreen()
        .navigationTitle("Walk the shelf")
        .task(id: "\(persistenceNamespace).\(locationID?.rawValue ?? "all")") {
            let session = RecountSession(
                service: model.client,
                persistenceNamespace: persistenceNamespace)
            self.session = session
            await session.loadTree()
            if await session.resumePending(scope: locationID) { return }
            if let locationID {
                await session.start(scope: locationID)
            }
        }
    }
}

/// Switches on the session's phase. Split out from `AuditRootView` so it — and each phase — stays
/// previewable without a network-backed session.
private struct AuditPhaseView: View {
    let session: RecountSession

    var body: some View {
        Group {
            switch session.phase {
            case .loading:
                LoadingIndicator.screen(label: "Loading audit tree")
            case .choosingScope:
                ScopePickerSheet(session: session)
            case .bin:
                BinView(session: session)
            case .complete:
                RecountSummaryView(session: session)
            case .failed(let message):
                LoadFailureView(title: "Couldn't load locations", message: message) {
                    await session.loadTree()
                }
            }
        }
    }
}

#Preview("Audit root", traits: .modifier(SignedInPreview())) {
    NavigationStack {
        AuditRootView(locationID: nil)
    }
}
