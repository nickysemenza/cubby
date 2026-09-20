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
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: symbol).font(.body.weight(.semibold))
            }
        }
        .padding(.horizontal, 7)
        .frame(minWidth: 28, minHeight: 28)
        .foregroundStyle(.primary)
        .background(.regularMaterial, in: Capsule())
        .shadow(radius: 2, y: 1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(state.accessibilityStatus)
        .help(state.accessibilityStatus)
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
