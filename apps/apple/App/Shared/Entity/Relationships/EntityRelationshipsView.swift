import CubbyKit
import SwiftUI

struct EntityRelationshipsSection: View {
    let source: EntityRef
    var body: some View {
        ConnectionsWorkspaceLink(entity: source.entityKind.rawValue, recordID: source.entityId)
            .accessibilityIdentifier("relationships.openConnections")
    }
}
