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

/// The explanation endpoint recomputes one record without publishing it.
struct DerivedExplanationSummary: View {
    let explanation: DerivedExplanation
    let field: FieldDescriptor

    private var stored: JSONValue? { try? JSONValue(encoding: explanation.stored) }
    private var live: JSONValue? {
        explanation.live.flatMap { try? JSONValue(encoding: $0) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            if ["stale", "waiting"].contains(explanation.meta.state.rawValue) {
                Text("Updating").foregroundStyle(FieldGuideTokens.info)
            }
            LabeledContent("Published") {
                if explanation.meta.state.rawValue == "missing" {
                    Text("Not published")
                } else {
                    value(stored)
                }
            }
            if let live {
                if stored == live {
                    Text("Live calculation matches the published value.")
                        .foregroundStyle(.secondary)
                } else {
                    LabeledContent("Live now") { value(live) }
                }
            } else {
                Text("Live value is not computed here.").foregroundStyle(.secondary)
            }
            if let asOf = explanation.meta.asOf, let label = DatePresentation.absolute(of: asOf) {
                Text("Published \(label)").foregroundStyle(.secondary)
            }
            if explanation.meta.state.rawValue == "failed" {
                Text("Calculation failed").foregroundStyle(FieldGuideTokens.warning)
                if let error = explanation.meta.error.valueIfPresent ?? nil {
                    Text(error).foregroundStyle(.secondary)
                }
            }
        }
        .font(.caption)
        .accessibilityIdentifier("field.explanation.derived")
    }

    @ViewBuilder
    private func value(_ value: JSONValue?) -> some View {
        if let value {
            if let text = EntityFieldValue.text(value, field: field) {
                Text(text)
            } else {
                switch value {
                case .array, .object:
                    DisclosureGroup("Evidence") { ExplanationEvidenceValue(value: value) }
                default:
                    ExplanationEvidenceValue(value: value)
                }
            }
        } else {
            Text("Unavailable")
        }
    }
}

#Preview("Structured calculation evidence") {
    if let field = EntityCatalog[.product].field("dataQuality") {
        let fixture: JSONValue = [
            "meta": ["state": "waiting", "asOf": .null, "decidedBy": .null],
            "stored": ["rulesVersion": 1, "score": 50, "checks": []],
            "live": ["rulesVersion": 1, "score": 100, "checks": []],
        ]
        if let explanation = try? fixture.decoded(DerivedExplanation.self) {
            DerivedExplanationSummary(explanation: explanation, field: field)
                .padding(FieldGuideTokens.Space.md)
        }
    }
}

#Preview("Published and live calculations") {
    if let field = EntityCatalog[.product].field("price") {
        let fixtures: [JSONValue] = [
            [
                "meta": ["state": "stale", "asOf": "2026-01-01T12:00:00.000Z", "decidedBy": .null],
                "stored": 12, "live": 18,
            ],
            ["meta": ["state": "fresh", "asOf": .null, "decidedBy": .null], "stored": 0, "live": 0],
            [
                "meta": ["state": "missing", "asOf": .null, "decidedBy": .null], "stored": .null,
                "live": .null,
            ],
            [
                "meta": [
                    "state": "failed", "asOf": .null, "decidedBy": .null,
                    "error": "Synthetic calculation failure",
                ],
                "stored": 12, "live": .null,
            ],
        ]
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.md) {
            ForEach(Array(fixtures.enumerated()), id: \.offset) { _, fixture in
                if let explanation = try? fixture.decoded(DerivedExplanation.self) {
                    DerivedExplanationSummary(explanation: explanation, field: field)
                }
            }
        }
        .padding(FieldGuideTokens.Space.md)
    }
}
