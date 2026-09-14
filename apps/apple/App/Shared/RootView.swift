import CubbyKit
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @State private var appliedStashedLaunchLink = false

    var body: some View {
        switch model.phase {
        case .restoring:
            VStack(spacing: PorcelainTokens.Space.md) {
                ProgressView()
                Text("Checking sign-in…")
                    .font(.porcelainBody)
                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(PorcelainTokens.canvas)
        case .signedOut:
            LoginView()
        case .signedIn:
            Group {
                #if os(iOS)
                    RootTabsView()
                #else
                    RootSplitView()
                #endif
            }
            .id(ObjectIdentifier(model.client))
            .task(id: model.host) {
                await model.spotlight.refreshIfNeeded(client: model.client, host: model.host)
            }
            #if os(iOS)
                .task { applyStashedLaunchLinkIfNeeded() }
            #endif
        }
    }

    #if os(iOS)
        /// Belt-and-suspenders for `AppDelegate`'s cold-launch Quick Action handling: in the
        /// ordinary case `AppModel.active` already exists by `willConnectTo` and the link is
        /// applied there directly, so this finds nothing. It only matters if that invariant is
        /// ever wrong — then the link is stashed instead of dropped, and this applies it once,
        /// the first time the signed-in shell appears.
        private func applyStashedLaunchLinkIfNeeded() {
            guard !appliedStashedLaunchLink, let link = AppDelegate.takeStashedLaunchLink() else { return }
            appliedStashedLaunchLink = true
            model.navigator.open(link)
        }
    #endif
}

#Preview("Signed out") {
    RootView().environment(PreviewFixtures.signedOutModel())
}

#Preview("Signed in") {
    RootView().environment(PreviewFixtures.signedInModel())
}
