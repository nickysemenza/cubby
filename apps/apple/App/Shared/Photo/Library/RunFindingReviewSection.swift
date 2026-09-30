import CubbyKit
import SwiftUI

/// Findings are projected from the generated snapshot; UUID internals never become review labels.
struct RunFindingReviewSection: View {
    let findings: [JSONValue]
    let busy: Bool
    let onResolve: (String, Bool, String?) -> Void
    @State private var confirming: JSONValue?

    var body: some View {
        Section("Suggested repairs") {
            ForEach(Array(findings.enumerated()), id: \.offset) { _, finding in
                findingRow(finding)
            }
        }
        .onChange(of: findings) { _, _ in confirming = nil }
        .confirmationDialog(
            "Apply this reviewed replacement?",
            isPresented: Binding(
                get: { confirming != nil },
                set: { if !$0 { confirming = nil } })
        ) {
            if let id = confirming?["id"]?.stringValue {
                Button("Apply reviewed replacement") {
                    onResolve(
                        id, true, confirming?["proposedFix"]?["reviewSnapshot"]?["fingerprint"]?.stringValue)
                    confirming = nil
                }
            }
        } message: {
            Text(
                "This replaces the original Expense with the exact item lines and party allocations shown in the review."
            )
        }
    }

    @ViewBuilder private func findingRow(_ finding: JSONValue) -> some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            Text(finding["summary"]?.stringValue ?? "Suggested repair")
                .font(.subheadline.weight(.medium))
            Text((finding["status"]?.stringValue ?? "unknown").capitalized)
                .font(.caption).foregroundStyle(.secondary)
            if let fix = finding["proposedFix"], fix["kind"]?.stringValue == "replace_aggregate_line" {
                replacementReview(fix)
                if finding["status"]?.stringValue == "open", let id = finding["id"]?.stringValue {
                    HStack {
                        Button("Apply reviewed replacement") { confirming = finding }
                            .disabled(busy || !hasReviewedSnapshot(fix))
                            .accessibilityIdentifier("run.finding.apply.\(id)")
                        Button("Dismiss") { onResolve(id, false, nil) }
                            .disabled(busy)
                            .accessibilityIdentifier("run.finding.dismiss.\(id)")
                    }
                }
            }
        }
        .padding(.vertical, FieldGuideTokens.Space.xs)
    }

    private func hasReviewedSnapshot(_ fix: JSONValue) -> Bool {
        fix["reviewSnapshot"]?["fingerprint"]?.stringValue != nil
            && fix["reviewedLineIdentities"]?.arrayValue != nil
            && fix["reviewedLineAttributions"]?.arrayValue != nil
    }

    @ViewBuilder private func replacementReview(_ fix: JSONValue) -> some View {
        if let original = fix["reviewSnapshot"], hasReviewedSnapshot(fix) {
            Text("Original Expense").font(.caption.weight(.semibold))
            LabeledContent("Name", value: original["title"]?.stringValue ?? "Expense")
            if let amount = original["amount"]?.doubleValue {
                LabeledContent("Amount", value: amount.formatted(.currency(code: "USD")))
            }
            originalValue("Date", key: "date", original: original)
            originalValue("Project", key: "projectName", original: original)
            originalValue("Category", key: "categoryName", original: original)
            originalValue("Cost type", key: "costType", original: original)
            originalValue("Trade", key: "trade", original: original)
            originalValue("Notes", key: "notes", original: original)
            Text("Replacement lines").font(.caption.weight(.semibold))
            let lines = fix["lines"]?.arrayValue ?? []
            let identities = fix["reviewedLineIdentities"]?.arrayValue ?? []
            let attributions = fix["reviewedLineAttributions"]?.arrayValue ?? []
            ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                    LabeledContent(
                        line["title"]?.stringValue ?? "Item \(index + 1)",
                        value: (line["amount"]?.doubleValue ?? 0).formatted(.currency(code: "USD")))
                    originalValue("SKU", key: "sku", original: line)
                    originalValue("Seller", key: "seller", original: line)
                    if let quantity = line["quantity"]?.doubleValue {
                        LabeledContent("Quantity", value: quantity.formatted())
                    }
                    if identities.indices.contains(index) {
                        if let reason = identities[index]["unresolvedReason"]?.stringValue {
                            Text(reason).foregroundStyle(FieldGuideTokens.warning)
                        }
                        if identities[index]["variantDoubt"]?.boolValue == true {
                            Text("Exact variant needs review").foregroundStyle(FieldGuideTokens.warning)
                        }
                    }
                    ForEach(Array(attributions.enumerated()), id: \.offset) { _, share in
                        if share["lineIndex"]?.doubleValue == Double(index) {
                            LabeledContent(
                                "\((share["role"]?.stringValue ?? "Party").capitalized) · \(share["partyCode"]?.stringValue ?? "Party unresolved")",
                                value: (share["amount"]?.doubleValue ?? 0).formatted(.currency(code: "USD")))
                        }
                    }
                }
                .padding(.vertical, FieldGuideTokens.Space.xs)
            }
            Text(
                "The server rechecks this exact original Expense, its metadata, and each party's allocated cents before applying."
            )
            .font(.caption).foregroundStyle(.secondary)
        } else {
            Text(
                "Prepare the receipt again to review the original Expense and party allocations before applying."
            )
            .font(.caption).foregroundStyle(FieldGuideTokens.warning)
        }
    }

    @ViewBuilder private func originalValue(_ title: String, key: String, original: JSONValue) -> some View {
        if let value = original[key]?.stringValue, !value.isEmpty {
            LabeledContent(title, value: value)
        }
    }
}

#Preview {
    List {
        RunFindingReviewSection(
            findings: [
                .object([
                    "summary": .string("Synthetic receipt has two item lines"), "status": .string("open"),
                    "proposedFix": .object(["kind": .string("replace_aggregate_line")]),
                ])
            ], busy: false, onResolve: { _, _, _ in })
    }
}
