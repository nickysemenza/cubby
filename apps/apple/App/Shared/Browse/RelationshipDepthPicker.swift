import CubbyKit
import SwiftUI

/// Kept separate from the large relationship view for Xcode 26.6 IR stability.
struct RelationshipDepthPicker: View {
    let model: EntityRelationshipsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Picker(
                "Declared relationship depth",
                selection: Binding(
                    get: { model.depth },
                    set: { model.requestDepth($0) }
                )
            ) {
                Text("1").tag(1)
                Text("2").tag(2)
                Text("3").tag(3)
            }
            .pickerStyle(.segmented)
            .frame(minHeight: PorcelainTokens.touchTarget)
            .disabled(model.activity != .idle)
            Text("Depth counts declared relationship hops.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}
