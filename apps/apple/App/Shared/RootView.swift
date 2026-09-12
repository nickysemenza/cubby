import CubbyKit
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

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
            .task(id: model.host) {
                await model.spotlight.refreshIfNeeded(client: model.client, host: model.host)
            }
        }
    }
}

#Preview("Signed out") {
    RootView().environment(PreviewFixtures.signedOutModel())
}

#Preview("Signed in") {
    RootView().environment(PreviewFixtures.signedInModel())
}
