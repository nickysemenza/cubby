import CubbyKit
import SwiftUI

/// Server provenance is shown as a link only when the response supplies one concrete source entity.
struct EntityFieldResolutionLabel: View {
    let resolved: FieldResolutionPresentation
    let field: FieldDescriptor

    var body: some View {
        if resolved.isInherited {
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text("Inherited from").font(.caption).foregroundStyle(.secondary)
                if let source = resolved.sourceEntity,
                    let entity = EntityKey(rawValue: source.entityKind.rawValue)
                {
                    NavigationLink(value: Route.entityDetail(entity, id: source.entityId)) {
                        Text(source.name ?? source.entityId)
                            .font(.caption)
                            .foregroundStyle(.tint)
                    }
                    .buttonStyle(.plain)
                } else {
                    Text(resolved.resolution.source)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

#Preview {
    let field = EntityCatalog[.expense].field("spendingCategoryId")!
    let raw: JSONValue = [
        "fieldResolutions": [
            "spendingCategoryId": [
                "mode": "inherit", "storedValue": .null, "value": "SPC-4K7M", "fallbackValue": "SPC-4K7M",
                "source": "purchase",
                "sourceEntity": ["entityKind": "purchase", "entityId": "PUR-4K7M", "name": "Fixture order"],
                "matchesFallback": true, "canReset": false,
            ]
        ]
    ]
    EntityFieldResolutionLabel(resolved: FieldResolutionPresentation(raw: raw, field: field)!, field: field)
        .environment(PreviewFixtures.signedInModel())
        .padding()
}
