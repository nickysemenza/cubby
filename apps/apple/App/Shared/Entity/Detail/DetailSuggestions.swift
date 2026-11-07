import CubbyKit
import SwiftUI

/// The record's pending field Suggestions for its detail screen. Reads `suggestions.list` and
/// reviews through `suggestion.review(Batch)`; the server owns every outcome (ADR 0025).
@MainActor
@Observable
final class DetailSuggestionsModel {
    let entity: EntityKey
    let recordID: String
    private let client: CubbyClient
    private let onChanged: @MainActor () -> Void

    private(set) var items: [PendingFieldSuggestion] = []
    private(set) var error: String?
    private(set) var busy: Set<String> = []

    init(
        entity: EntityKey, recordID: String, client: CubbyClient,
        items: [PendingFieldSuggestion] = [], onChanged: @escaping @MainActor () -> Void = {}
    ) {
        self.entity = entity
        self.recordID = recordID
        self.client = client
        self.items = items
        self.onChanged = onChanged
    }

    /// Only entities with a suggest field can carry field Suggestions.
    static func applies(to descriptor: EntityDescriptor) -> Bool {
        descriptor.shortcodePrefix != nil && descriptor.fields.contains { $0.suggestion != nil }
    }

    func load() async {
        do {
            items = try await client.pendingFieldSuggestions(entity: entity, id: recordID)
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = error.userMessage
            Diagnostics.report(error, context: "detail.suggestions")
        }
    }

    func pending(for field: FieldDescriptor) -> PendingFieldSuggestion? {
        items.first { $0.field == field.key || $0.field == field.readKey }
    }

    var cleanItems: [PendingFieldSuggestion] { items.filter { $0.clean && $0.canAccept } }

    func review(_ suggestion: PendingFieldSuggestion, accept: Bool) async {
        guard busy.insert(suggestion.id).inserted else { return }
        defer { busy.remove(suggestion.id) }
        do {
            try await client.review(suggestion, accept: accept)
            error = nil
        } catch {
            self.error = error.userMessage
            Diagnostics.report(error, context: "detail.suggestion.review")
        }
        await settle()
    }

    func acceptClean() async {
        let clean = cleanItems
        guard !clean.isEmpty, busy.isEmpty else { return }
        busy = Set(clean.map(\.id))
        defer { busy = [] }
        do {
            let refusals = try await client.accept(clean)
            error = refusals.isEmpty ? nil : refusals.joined(separator: "\n")
        } catch {
            self.error = error.userMessage
            Diagnostics.report(error, context: "detail.suggestion.reviewBatch")
        }
        await settle()
    }

    private func settle() async {
        onChanged()
        let error = error
        await load()
        if let error { self.error = error }
    }
}

extension EnvironmentValues {
    /// The detail's pending Suggestions; nil outside a record detail.
    @Entry var detailSuggestions: DetailSuggestionsModel?
}

/// The quiet marker under a field row with a pending Suggestion: the proposed value with Accept
/// and Dismiss.
struct FieldSuggestionMarker: View {
    let suggestion: PendingFieldSuggestion
    let field: FieldDescriptor
    let model: DetailSuggestionsModel

    private var proposed: String {
        EntityFieldValue.text(suggestion.suggestedValue, field: field) ?? suggestion.suggestedValue
            .stringValue
            ?? "None"
    }

    var body: some View {
        let busy = model.busy.contains(suggestion.id)
        HStack(alignment: .firstTextBaseline, spacing: FieldGuideTokens.Space.sm) {
            Image(systemName: "sparkles").foregroundStyle(.tint).accessibilityHidden(true)
            Text("Suggested: \(proposed)")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: FieldGuideTokens.Space.xs)
            if busy {
                ProgressView().controlSize(.small)
            } else {
                if suggestion.canDismiss {
                    Button("Dismiss") { Task { await model.review(suggestion, accept: false) } }
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("detail.suggestion.\(field.key).dismiss")
                }
                if suggestion.canAccept {
                    Button("Accept") { Task { await model.review(suggestion, accept: true) } }
                        .fontWeight(.semibold)
                        .accessibilityIdentifier("detail.suggestion.\(field.key).accept")
                }
            }
        }
        .font(.caption)
        .buttonStyle(.borderless)
        .frame(minHeight: FieldGuideTokens.touchTarget)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(field.label) suggestion: \(proposed)")
    }
}

/// "N suggestions" near the glance: every pending Suggestion in one disclosure, plus Accept all
/// for the clean ones. Shown when there are several, or when one has no visible field row.
struct DetailSuggestionsRow: View {
    let descriptor: EntityDescriptor
    let model: DetailSuggestionsModel
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            ForEach(model.items) { suggestion in
                if let field = descriptor.field(suggestion.field)
                    ?? descriptor.fields.first(where: { $0.readKey == suggestion.field })
                {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(field.label).font(.subheadline)
                        FieldSuggestionMarker(suggestion: suggestion, field: field, model: model)
                    }
                }
            }
            if model.cleanItems.count > 1 {
                Button("Accept \(model.cleanItems.count) clean suggestions") {
                    Task { await model.acceptClean() }
                }
                .disabled(!model.busy.isEmpty)
                .frame(minHeight: FieldGuideTokens.touchTarget)
                .accessibilityIdentifier("detail.suggestions.acceptClean")
            }
        } label: {
            Label(
                model.items.count == 1 ? "1 suggestion" : "\(model.items.count) suggestions",
                systemImage: "sparkles"
            )
            .frame(minHeight: FieldGuideTokens.touchTarget)
        }
        .accessibilityIdentifier("detail.suggestions")
        if let error = model.error {
            Text(error)
                .font(.caption)
                .foregroundStyle(FieldGuideTokens.destructive)
                .textSelection(.enabled)
        }
    }
}

#Preview("Detail suggestions") {
    let app = PreviewFixtures.signedInModel()
    let descriptor = EntityCatalog[.product]
    let fields = descriptor.fields.filter { $0.suggestion != nil }.prefix(2)
    let model = DetailSuggestionsModel(
        entity: .product, recordID: PreviewFixtures.sampleDetailRow.id, client: app.client,
        items: fields.map {
            PendingFieldSuggestion(
                id: "SUG-\($0.key)", suggestionID: "SUG-\($0.key)", field: $0.key,
                suggestedValue: "Synthetic value", clean: true)
        })
    List { DetailSuggestionsRow(descriptor: descriptor, model: model) }
        .environment(app)
}
