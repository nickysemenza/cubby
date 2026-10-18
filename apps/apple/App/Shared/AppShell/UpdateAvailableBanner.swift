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
            Link("Open TestFlight", destination: URL(string: "https://testflight.apple.com")!)
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

#Preview("Update available") {
    UpdateAvailableBanner()
}
