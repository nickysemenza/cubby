import CubbyKit
import SwiftUI

/// Server provenance is shown as a link only when the response supplies one concrete source entity.
struct EntityFieldResolutionLabel: View {
    let resolved: FieldResolutionPresentation
    @Environment(AppModel.self) private var appModel

    var body: some View {
        if let source = resolved.sourceEntity,
            let entity = EntityKey(rawValue: source.entityKind.rawValue)
        {
            HStack(alignment: .firstTextBaseline, spacing: FieldGuideTokens.Space.sm) {
                Text(resolved.sourceText).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: FieldGuideTokens.Space.sm)
                Button {
                    appModel.navigator.openRecord(RecordSelection(key: entity, id: source.entityId))
                } label: {
                    Label(source.name ?? source.entityId, systemImage: "chevron.right")
                        .font(.caption)
                        .frame(minHeight: FieldGuideTokens.touchTarget, alignment: .trailing)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .frame(maxWidth: .infinity)
        } else {
            Text(resolved.sourceText).font(.caption).foregroundStyle(.secondary)
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
    EntityFieldResolutionLabel(resolved: FieldResolutionPresentation(raw: raw, field: field)!)
        .environment(PreviewFixtures.signedInModel())
        .padding()
}
