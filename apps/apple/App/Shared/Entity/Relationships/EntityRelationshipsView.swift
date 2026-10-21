import CubbyKit
import SwiftUI

struct EntityRelationshipsSection: View {
    let source: EntityRef
    var body: some View {
        ConnectionsWorkspaceLink(entity: source.entityKind.rawValue, recordID: source.entityId)
            .accessibilityIdentifier("relationships.openConnections")
    }
}

#Preview {
    EntityRelationshipsSection(source: .init(entity: .product, id: "PRD-4K7M"))
        .environment(PreviewFixtures.signedInModel())
}
