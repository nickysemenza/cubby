import CubbyKit
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.phase {
        case .restoring:
            ProgressView("Checking sign-in…")
        case .signedOut:
            LoginView()
        case .signedIn:
            #if os(iOS)
            RootTabsView()
            #else
            RootSplitView()
            #endif
        }
    }
}

#Preview("Signed out") {
    RootView().environment(PreviewFixtures.signedOutModel())
}

#Preview("Signed in") {
    RootView().environment(PreviewFixtures.signedInModel())
}
