import CubbyKit
import SwiftUI

/// Kept separate from the large relationship view for Xcode 26.6 IR stability.
struct RelationshipDepthPicker: View {
    let model: EntityRelationshipsModel

    var body: some View {
        Picker(
            "Depth",
            selection: Binding(
                get: { model.depth },
                set: { model.requestDepth($0) }
            )
        ) {
            Text("1 hop").tag(1)
            Text("2 hops").tag(2)
            Text("3 hops").tag(3)
        }
        .pickerStyle(.segmented)
        .frame(minHeight: PorcelainTokens.touchTarget)
        .disabled(model.activity != .idle)
    }
}
