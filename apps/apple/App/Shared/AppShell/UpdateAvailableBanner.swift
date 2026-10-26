import SwiftUI

/// Pinned above the app once the server's version gate has answered 426. The server still serves
/// this build's reads, so every screen stays open; its writes are refused, and the refused action
/// shows the server's message in place. `RequestTrace.clientUpdateRequired` latches it; only a
/// newer TestFlight build clears it.
struct UpdateAvailableBanner: View {
    var body: some View {
        HStack(spacing: FieldGuideTokens.Space.sm) {
            Label {
                Text("This version of Cubby can't save changes. Update it from TestFlight.")
            } icon: {
                Image(systemName: "arrow.down.app")
            }
            .font(.footnote)
            Spacer(minLength: 0)
            OpenTestFlightButton()
                .font(.footnote.weight(.semibold))
                .buttonStyle(.bordered)
                .controlSize(.small)
        }
        .padding(.horizontal, FieldGuideTokens.Space.md)
        .padding(.vertical, FieldGuideTokens.Space.sm)
        .frame(maxWidth: .infinity)
        .background(.bar)
    }
}

/// Opens the TestFlight app (`itms-beta://`), falling back to the TestFlight web page when no app
/// takes the scheme. Shared by the banner and Settings › About.
struct OpenTestFlightButton: View {
    @Environment(\.openURL) private var openURL

    var body: some View {
        Button("Open TestFlight") {
            openURL(URL(string: "itms-beta://")!) { accepted in
                if !accepted { openURL(URL(string: "https://testflight.apple.com")!) }
            }
        }
        .accessibilityIdentifier("update.openTestFlight")
    }
}

#Preview("Update available") {
    UpdateAvailableBanner()
}
