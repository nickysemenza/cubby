import CubbyKit
import SwiftUI

@main
struct CubbyApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(PorcelainTokens.cobalt)
                // Porcelain Transit is a light-only palette (DESIGN.md). Pin the scheme so the
                // system chrome never goes dark over a porcelain canvas; dark tokens come later.
                .preferredColorScheme(.light)
                .task { await model.restoreSession() }
        }
        #if os(macOS)
        Settings {
            SettingsView()
                .environment(model)
                .frame(width: 420)
        }
        #endif
    }
}
