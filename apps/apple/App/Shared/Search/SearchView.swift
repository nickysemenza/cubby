import CubbyKit
import SwiftUI

/// Placeholder until the Search tab lands; keeps `SectionView` exhaustive.
struct SearchView: View {
    var body: some View {
        ContentUnavailableView.search
    }
}

#Preview {
    SearchView().environment(PreviewFixtures.signedInModel())
}
