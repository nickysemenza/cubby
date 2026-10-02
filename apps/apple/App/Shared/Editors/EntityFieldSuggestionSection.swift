import CubbyKit
import SwiftUI

struct EntityFieldSuggestionSection: View {
    @Bindable var review: FieldSuggestionReviewModel
    let pickedTitles: [String: String]
    let onSavedCategory: (String, JSONValue, String?) -> Void

    @State private var errorMessage: String?
    @State private var actionTask: Task<Void, Never>?

    var body: some View {
        Section("Suggestions") {
            Button(review.response == nil ? "Suggest fields" : "Review fresh suggestions") {
                perform { try await review.request() }
            }
            .disabled(review.isLoading || review.isApplying)
            .accessibilityIdentifier("editor.suggestions.request")
            if review.isLoading {
                LoadingIndicator(label: "Considering available evidence")
            }
            if let errorMessage {
                Text(errorMessage).foregroundStyle(FieldGuideTokens.destructive)
            }
            if review.response != nil {
                ForEach(review.fields, id: \.key) { field in
                    if let proposal = review.proposal(field.key) {
                        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                            Text(field.label).font(.headline)
                            Text("Current: \(currentText(field))").foregroundStyle(.secondary)
                            Text(proposal.label ?? proposal.value ?? "")
                            if let detail = proposal.detail { Text(detail).foregroundStyle(.secondary) }
                            if let evidence = proposal.financeReview?.evidence {
                                Text(
                                    "\(evidence.principalLineCount) lines across \(evidence.distinctPurchaseCount) purchases; \(evidence.unknownCategoryLineCount) without a product category"
                                ).font(.caption)
                                ForEach(evidence.categories, id: \.id) { category in
                                    NavigationLink(
                                        category.name,
                                        value: Route.entityDetail(.productCategory, id: category.id))
                                }
                            }
                            if !proposal.alternatives.isEmpty {
                                DisclosureGroup("Alternatives") {
                                    ForEach(proposal.alternatives, id: \.value) { alternative in
                                        VStack(alignment: .leading) {
                                            Text(alternative.label)
                                            if let detail = alternative.detail {
                                                Text(detail).font(.caption).foregroundStyle(.secondary)
                                            }
                                        }
                                    }
                                }
                            }
                            Text(proposal.reasoning).font(.caption).foregroundStyle(.secondary)
                            Text(
                                proposal.financeReview == nil
                                    ? "Use in draft changes this editor. Save commits the choice."
                                    : "Based on saved record and linked items. Apply saves the reviewed field immediately."
                            )
                            .font(.caption).foregroundStyle(.secondary)
                            HStack {
                                Button(
                                    proposal.financeReview == nil ? "Use in draft" : "Apply and save"
                                ) {
                                    perform {
                                        if case .saved(let key, let value) = try await review.apply(field.key)
                                        {
                                            onSavedCategory(key, value, proposal.label)
                                        }
                                    }
                                }
                                .disabled(review.isApplying || review.isLoading)
                                .accessibilityIdentifier("editor.suggestions.\(field.key).apply")
                                Button("Dismiss") { review.dismiss(field.key) }
                                    .disabled(review.isApplying)
                            }
                        }
                        .accessibilityElement(children: .contain)
                    } else {
                        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                            Text(field.label).font(.headline)
                            Text(outcomeText(field.key)).foregroundStyle(.secondary)
                        }
                    }
                }
                if review.reviewedFinanceFields.count > 1 {
                    Button("Apply all reviewed suggestions") {
                        perform {
                            for acceptance in try await review.applyReviewedFields() {
                                if case .saved(let key, let value) = acceptance {
                                    onSavedCategory(key, value, nil)
                                }
                            }
                        }
                    }.disabled(review.isApplying || review.isLoading)
                }
                if !review.fields.contains(where: { review.proposal($0.key) != nil }) {
                    Text("No current suggestion to review. Edit the fields or request fresh suggestions.")
                        .foregroundStyle(.secondary)
                }
            }
            if review.isApplying { LoadingIndicator(label: "Saving reviewed fields") }
        }
        .onDisappear { actionTask?.cancel() }
    }

    private func outcomeText(_ key: String) -> String {
        switch review.response?.outcomes?.additionalProperties[key] {
        case .skipped(let outcome):
            switch outcome.reason {
            case .noSignal: return "Available evidence does not support a suggestion."
            case .noCandidates: return "No choices are available."
            case .resolved: return "The current inherited policy already resolves this field."
            }
        case .evaluated(let outcome):
            return outcome.answer == .none
                ? "No suggested change from the available evidence."
                : "Review dismissed or draft changed. Request fresh suggestions."
        case nil:
            return "No current suggestion to review."
        }
    }

    private func currentText(_ field: FieldDescriptor) -> String {
        let value = review.editor.draft[field.key] ?? .null
        if let id = value.stringValue, let name = pickedTitles[id] { return name }
        return EntityFieldValue.text(value, field: field) ?? "None"
    }

    private func perform(_ action: @escaping @MainActor () async throws -> Void) {
        guard actionTask == nil else { return }
        errorMessage = nil
        actionTask = Task {
            defer { actionTask = nil }
            do { try await action() } catch {
                guard !Task.isCancelled else { return }
                Diagnostics.report(error, context: "entity field suggestion review")
                errorMessage = error.localizedDescription
            }
        }
    }
}

#Preview {
    @Previewable @State var editor = GenericEntityEditModel(
        descriptor: EntityCatalog[.purchase], mode: .create(prefill: [:]),
        client: PreviewFixtures.signedInModel().client)
    Form {
        EntityFieldSuggestionSection(
            review: FieldSuggestionReviewModel(
                editor: editor, fetch: { _ in .init(suggestions: []) },
                saveCategory: { _ in throw CancellationError() }),
            pickedTitles: [:], onSavedCategory: { _, _, _ in })
    }
    .formStyle(.grouped)
}
