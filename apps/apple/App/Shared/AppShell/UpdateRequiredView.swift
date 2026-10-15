import SwiftUI

/// Shown in place of the whole app once the server's version gate has answered 426: this build
/// predates a wire change, so every screen would fail to decode. `RequestTrace.clientUpdateRequired`
/// latches it; only a newer TestFlight build clears it.
struct UpdateRequiredView: View {
    var body: some View {
        ContentUnavailableView {
            Label("Update Cubby", systemImage: "arrow.down.app")
        } description: {
            Text(
                "This version of Cubby is too old for the server. Update Cubby from TestFlight, then reopen it."
            )
        } actions: {
            Link("Open TestFlight", destination: URL(string: "https://testflight.apple.com")!)
                .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(FieldGuideTokens.canvas)
    }
}

#Preview("Update required") {
    UpdateRequiredView()
}
