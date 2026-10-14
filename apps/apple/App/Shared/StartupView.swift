import SwiftUI

struct StartupView: View {
    var body: some View {
        Text("Cubby")
            .font(.largeTitle.weight(.semibold))
            .foregroundStyle(.primary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .ignoresSafeArea()
            .overlay(alignment: .bottom) {
                LoadingIndicator(label: "Checking sign-in")
                    .padding(FieldGuideTokens.Space.xxl)
            }
            .background(FieldGuideTokens.canvas.ignoresSafeArea())
    }
}

#Preview { StartupView() }
