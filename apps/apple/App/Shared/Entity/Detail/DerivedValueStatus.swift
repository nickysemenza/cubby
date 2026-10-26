import CubbyKit
import SwiftUI

/// Reads the generic envelope without introducing a second native wire model.
struct DerivedValueStatus: View {
    let raw: JSONValue
    let field: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static func isUpdating(in raw: JSONValue, field: String? = nil) -> Bool {
        let metadata: [JSONValue]
        if let field {
            metadata = raw["derived"]?[field].map { [$0] } ?? []
        } else {
            metadata = raw["derived"]?.objectValue.map { Array($0.values) } ?? []
        }
        return metadata.contains { ["stale", "waiting"].contains($0["state"]?.stringValue ?? "") }
    }

    var body: some View {
        if Self.isUpdating(in: raw, field: field) {
            Image(systemName: "circle.fill")
                .font(.system(size: 6))
                .foregroundStyle(FieldGuideTokens.info)
                .symbolEffect(.pulse, options: .repeating, isActive: !reduceMotion)
                .accessibilityLabel("Updating")
                .help("Updating")
        }
    }
}

struct DerivedProvenanceCaption: View {
    let raw: JSONValue
    let field: String
    var includeInherited = true

    var body: some View {
        let deciding = raw["derived"]?[field]?["decidedBy"]
        if deciding?["level"]?.stringValue == "suggested", deciding?["auto"]?.boolValue == true {
            Text("Auto suggestion").font(.caption).foregroundStyle(.secondary)
        } else if deciding?["level"]?.stringValue == "inherited", includeInherited {
            HStack(spacing: FieldGuideTokens.Space.xs) {
                Text("Inherited from").foregroundStyle(.secondary)
                if let source = deciding?["source"], let kind = source["entity"]?.stringValue,
                    let entity = EntityKey(rawValue: kind), let id = source["id"]?.stringValue
                {
                    NavigationLink(value: Route.entityDetail(entity, id: id)) {
                        Text(source["label"]?.stringValue ?? id)
                    }.buttonStyle(.plain)
                }
            }.font(.caption)
        }
    }
}
