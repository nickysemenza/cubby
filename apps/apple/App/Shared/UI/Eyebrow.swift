import SwiftUI

/// A quiet sentence-case label above a region. Pair with 8pt of spacing below it — that gap is the
/// caller's, so an eyebrow can sit in a stack, a list header, or a panel without fighting insets.
struct Eyebrow: View {
    private let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.porcelainLabel)
            .foregroundStyle(PorcelainTokens.graphiteSecondary)
            .textCase(nil)
    }
}

#Preview("Eyebrow") {
    VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
        Eyebrow("This sweep")
        Text("14 added · 3 confirmed").font(.porcelainData)
    }
    .padding(PorcelainTokens.Space.lg)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(PorcelainTokens.canvas)
}
