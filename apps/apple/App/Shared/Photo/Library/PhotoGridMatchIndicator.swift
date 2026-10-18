import CubbyKit
import SwiftUI

struct PhotoGridMatchIndicator: View {
    let state: PhotoGridCellState

    var body: some View {
        Group {
            if let text = state.ownerBadgeText {
                Text(text).font(.caption2.weight(.semibold).monospaced())
                    .lineLimit(1).minimumScaleFactor(0.75)
            } else if state.matchState == .checking {
                ProgressView().controlSize(.mini)
            } else {
                Image(systemName: symbol).font(.caption.weight(.semibold))
            }
        }
        // A compact pill: at 28pt it dominated a ~100pt grid tile.
        .padding(.horizontal, 5)
        .frame(minWidth: 20, minHeight: 20)
        .foregroundStyle(categoryTint == nil ? AnyShapeStyle(.primary) : AnyShapeStyle(.white))
        .background {
            if let categoryTint {
                Capsule().fill(categoryTint)
            } else {
                Capsule().fill(.regularMaterial)
            }
        }
        .shadow(radius: 1, y: 0.5)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(state.accessibilityStatus)
        .help(state.accessibilityStatus)
    }

    /// B4's category signal, carried by the pill itself (it replaced a separate 6pt dot): the
    /// category's tint (by ramp index, never by key) once a hit lands, grey once analysed with no
    /// hit, and the plain material pill while analysis is pending.
    private var categoryTint: Color? {
        guard case .analysed(let categories) = state.analysis else { return nil }
        return PhotoCategoryTint.color(for: categories) ?? .gray
    }

    private var symbol: String {
        switch state.matchState {
        case .unchecked: "questionmark.circle"
        case .checking: "arrow.trianglehead.2.clockwise"
        case .strong: "checkmark.circle.fill"
        case .possible: "questionmark.circle.fill"
        case .unmatched: "photo.badge.plus"
        case .unavailable: "exclamationmark.triangle.fill"
        }
    }
}

#Preview("Match states") {
    VStack(alignment: .leading) {
        ForEach(
            [PhotoGridMatchState.unchecked, .checking, .strong, .possible, .unmatched, .unavailable],
            id: \.rawValue
        ) { matchState in
            HStack {
                PhotoGridMatchIndicator(
                    state: .init(
                        matchState: matchState, ownerBadgeText: nil,
                        accessibilityStatus: matchState.rawValue, indexIsComplete: true))
                Text(matchState.rawValue)
            }
        }
    }.padding()
}
