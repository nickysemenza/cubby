import CubbyKit
import SwiftUI

/// Server provenance is shown as a link only when the response supplies one concrete source entity.
struct EntityFieldResolutionLabel: View {
    let resolved: FieldResolutionPresentation
    let field: FieldDescriptor

    /// Where the value comes from; an explicit value reads in the state's words (Set here,
    /// Redundant, None), so an intentional pin is never called redundant.
    private var caption: String {
        switch resolved.resolution.mode {
        case .inherit, .allocated: resolved.sourceText
        case .explicit, .none: resolved.state(field: field).label
        }
    }

    var body: some View {
        if let source = resolved.sourceEntity,
            let entity = EntityKey(rawValue: source.entityKind.rawValue)
        {
            HStack(alignment: .firstTextBaseline, spacing: FieldGuideTokens.Space.sm) {
                Text(caption).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: FieldGuideTokens.Space.sm)
                NavigationLink(value: Route.entityDetail(entity, id: source.entityId)) {
                    Label(source.name ?? source.entityId, systemImage: "chevron.right")
                        .font(.caption)
                        .frame(minHeight: FieldGuideTokens.touchTarget, alignment: .trailing)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .frame(maxWidth: .infinity)
            .navigationLinkIndicatorVisibility(.hidden)
        } else {
            Text(caption).font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
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
