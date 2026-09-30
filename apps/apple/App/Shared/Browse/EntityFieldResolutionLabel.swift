import CubbyKit
import SwiftUI

/// Server provenance is shown as a link only when the response supplies one concrete source entity.
struct EntityFieldResolutionLabel: View {
    let resolved: FieldResolutionPresentation

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            Text(resolved.sourceText).font(.caption).foregroundStyle(.secondary)
            if let source = resolved.sourceEntity,
                let entity = EntityKey(rawValue: source.entityKind.rawValue)
            {
                NavigationLink(value: Route.entityDetail(entity, id: source.entityId)) {
                    Text(source.name ?? source.entityId).font(.caption)
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
    EntityFieldResolutionLabel(resolved: FieldResolutionPresentation(raw: raw, field: field)!)
        .padding()
}
