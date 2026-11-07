import CubbyKit
import SwiftUI

/// Merge for a selection of two or more records: the server's preview (`entity.mergePreview`)
/// with its suggested survivor preselected and switchable, a value choice for each conflicting
/// field, each merged-away record's connections with the server's disposition (moved, kept on the
/// merged record, discarded, blocking), and the server's blockers, which keep Merge off. One
/// irreversible confirmation sends the same kernel merge web sends, chosen values included.
struct EntityMergeSheet: View {
    @Bindable var model: EntityMergeModel
    let onFinished: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var confirming = false

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Merge \(model.ids.count.formatted()) \(model.descriptor.plural)")
                #if os(iOS)
                    .navigationBarTitleDisplayMode(.inline)
                #endif
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                            .disabled(model.isMerging)
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Merge…") { confirming = true }
                            .disabled(!model.canMerge)
                            .accessibilityIdentifier("merge.start")
                    }
                }
                .confirmationDialog(
                    "Merge into \(survivorName)?", isPresented: $confirming, titleVisibility: .visible
                ) {
                    Button(
                        "Merge \(model.ids.count.formatted()) \(model.descriptor.plural)", role: .destructive
                    ) {
                        Task {
                            if await model.merge() {
                                onFinished()
                                dismiss()
                            }
                        }
                    }
                    .accessibilityIdentifier("merge.confirm")
                } message: {
                    Text(
                        "The other records are removed and their connections follow the preview. This can't be undone."
                    )
                }
                .interactiveDismissDisabled(model.isMerging)
                .task { if model.preview == nil { await model.load() } }
                .task(id: model.keepID) { await model.refreshPlan() }
        }
        #if os(macOS)
            .frame(minWidth: 460, minHeight: 380)
        #endif
    }

    private var survivorName: String {
        guard let preview = model.preview, let keep = model.keepID else { return "the survivor" }
        return candidateName(keep, in: preview)
    }

    private func candidateName(_ id: String, in preview: EntityMergePreviewOut) -> String {
        preview.candidates.first { $0.id == id }?.name ?? id
    }

    @ViewBuilder
    private var content: some View {
        if let preview = model.preview {
            Form {
                if let failure = model.failure {
                    Section {
                        ActionFailureNotice(title: "Couldn't merge", message: failure, canRetry: false)
                    }
                }
                if !model.blockers.isEmpty {
                    Section {
                        ForEach(model.blockers, id: \.self) { blocker in
                            Label(blocker, systemImage: "exclamationmark.octagon")
                                .foregroundStyle(FieldGuideTokens.destructive)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    } header: {
                        Text("Can't merge into \(survivorName)")
                    }
                    .accessibilityIdentifier("merge.blockers")
                }
                Section {
                    Picker("Keep", selection: $model.keepID) {
                        ForEach(preview.candidates, id: \.id) { candidate in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(candidate.name ?? candidate.id)
                                Text(
                                    candidateCaption(
                                        candidate, suggested: candidate.id == preview.suggestedKeepId)
                                )
                                .font(.caption)
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                            }
                            .tag(Optional(candidate.id))
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                    .accessibilityIdentifier("merge.keep")
                } header: {
                    Text("Keep")
                } footer: {
                    Text("The suggested record has the most connections. Choose another to keep it instead.")
                }
                if !preview.conflicts.isEmpty {
                    Section {
                        ForEach(preview.conflicts, id: \.field) { conflict in
                            Picker(conflict.label, selection: choice(conflict)) {
                                ForEach(options(conflict, preview: preview), id: \.id) { option in
                                    Text(option.label).tag(Optional(option.id))
                                }
                            }
                            .accessibilityIdentifier("merge.conflict.\(conflict.field)")
                        }
                    } header: {
                        Text("Different values")
                    } footer: {
                        Text("The kept record takes the value you choose as part of the merge.")
                    }
                }
                connectionsSection
            }
            .formStyle(.grouped)
        } else if let error = model.loadError {
            LoadFailureView(title: "Couldn't load the merge preview", message: error) { await model.load() }
        } else {
            LoadingIndicator.screen(label: "Loading merge preview")
        }
    }

    /// Each merged-away record's incoming connections with what the merge does to them, as the
    /// server declares it; the merge re-checks before it runs.
    @ViewBuilder
    private var connectionsSection: some View {
        let mergedAway = model.mergedAway
        Section {
            if mergedAway.allSatisfy({ $0.connections.isEmpty }) {
                Text("Nothing points at the records being merged.")
                    .foregroundStyle(.secondary)
            }
            ForEach(mergedAway, id: \.id) { candidate in
                if !candidate.connections.isEmpty {
                    Text(candidate.name ?? candidate.id)
                        .font(.fieldGuideLabel)
                        .foregroundStyle(.secondary)
                    ForEach(candidate.connections, id: \.edgeKey) { group in
                        connectionRow(group)
                    }
                }
            }
        } header: {
            Text("Connections")
        } footer: {
            Text("From the server's merge rules. The merge checks again before it runs.")
        }
        .accessibilityIdentifier("merge.connections")
    }

    private func connectionRow(_ group: EntityConnectionGroup) -> some View {
        let blocking = group.disposition?.effect == .block
        return VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            LabeledContent("\(group.label) (\(group.count.formatted()))") {
                Text(dispositionPhrase(group.disposition?.effect))
                    .foregroundStyle(blocking ? FieldGuideTokens.destructive : .secondary)
            }
            if let description = group.disposition?.description {
                Text(description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// Web's impact-preview wording for the server's disposition effect.
    private func dispositionPhrase(_ effect: OperationEffect?) -> String {
        switch effect {
        case .repoint?: "Moves to \(survivorName)"
        case .moveDedupe?: "Merged into the matching record"
        case .preserve?: "Stays on the merged record"
        case .softDelete?: "Deleted with it"
        case .hardDelete?: "Permanently removed"
        case .detach?: "Link is cleared"
        case .block?: "Blocks the merge"
        case .unrecognized(let raw)?: raw
        case nil: "No impact recorded"
        }
    }

    private func candidateCaption(_ candidate: EntityMergeCandidate, suggested: Bool) -> String {
        let connections =
            "\(candidate.connectionCount.formatted()) connection\(candidate.connectionCount == 1 ? "" : "s")"
        let created = "Created \(candidate.createdAt.formatted(date: .abbreviated, time: .omitted))"
        return ([candidate.id, connections, created] + (suggested ? ["Suggested"] : [])).joined(
            separator: " · ")
    }

    private struct Option {
        let id: String
        let label: String
    }

    /// Each candidate's worded value, plus "No value" for a survivor that has none.
    private func options(_ conflict: EntityMergeConflict, preview: EntityMergePreviewOut) -> [Option] {
        var options = conflict.values.map { value in
            Option(id: value.id, label: "\(value.display) — \(candidateName(value.id, in: preview))")
        }
        if let keep = model.keepID, !conflict.values.contains(where: { $0.id == keep }) {
            options.insert(Option(id: keep, label: "No value — \(candidateName(keep, in: preview))"), at: 0)
        }
        return options
    }

    private func choice(_ conflict: EntityMergeConflict) -> Binding<String?> {
        Binding(
            get: { model.chosen(conflict) },
            set: { model.choices[conflict.field] = $0 })
    }
}

#Preview("Merge", traits: .modifier(SignedInPreview())) {
    @Previewable @Environment(AppModel.self) var appModel
    EntityMergeSheet(
        model: EntityMergeModel(
            descriptor: EntityCatalog[.product], ids: ["PRD-2345", "PRD-3456"], client: appModel.client)
    ) {}
}
