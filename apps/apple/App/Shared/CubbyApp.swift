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
