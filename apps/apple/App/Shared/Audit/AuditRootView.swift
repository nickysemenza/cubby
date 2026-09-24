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
        .porcelainScreen()
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
                AuditFailedPanel(message: message) { Task { await session.loadTree() } }
            }
        }
    }
}

/// The error state: what went wrong reading the location tree, and a way to try again.
private struct AuditFailedPanel: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PorcelainTokens.Space.lg) {
                Panel {
                    Text(message)
                        .font(.porcelainBody)
                        .foregroundStyle(PorcelainTokens.destructive)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Retry", action: retry)
                        .buttonStyle(.borderedProminent)
                        .tint(PorcelainTokens.cobalt)
                }
            }
            .padding(PorcelainTokens.Space.lg)
            .frame(maxWidth: PorcelainTokens.readingWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .porcelainScreen()
    }
}

#Preview("Audit root", traits: .modifier(SignedInPreview())) {
    NavigationStack {
        AuditRootView(locationID: nil)
    }
}

#Preview("Audit — failed") {
    AuditFailedPanel(message: "The server returned an error.") {}
}
