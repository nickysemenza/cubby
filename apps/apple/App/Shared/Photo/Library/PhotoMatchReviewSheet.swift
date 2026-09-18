import CubbyKit
import Observation
import SwiftUI

/// Presenter-owned wrapper for `.sheet(item:)`: the draft is built once, alongside the batch, by
/// the presenter — not seeded into the sheet's own `@State` from an init parameter, which is not
/// guaranteed to reset across a re-presentation with a different item (apps/apple/AGENTS.md,
/// "Traps that cost real time").
struct PhotoMatchReviewBatch: Identifiable {
    let id = UUID()
    let items: [PhotoSelectionItem]
    let draft: PhotoReviewDraft
}

struct PhotoMatchReviewSheet: View {
    @Environment(\.dismiss) private var dismiss
    let draft: PhotoReviewDraft
    let onContinue: ([PhotoSelectionItem]) -> Void

    var body: some View {
        NavigationStack {
            PhotoMatchReviewContent(
                draft: draft,
                onCancel: { dismiss() },
                onContinue: {
                    onContinue($0)
                    dismiss()
                })
        }
        .nativeSheet(.photo)
    }
}

@MainActor
@Observable
final class PhotoReviewDraft {
    let items: [PhotoSelectionItem]
    private(set) var decisions: [String: ImageCode]
    private(set) var addNew: [String: Set<ImageCode>]

    init(items: [PhotoSelectionItem]) {
        self.items = items
        decisions = Dictionary(
            uniqueKeysWithValues: items.compactMap { item in
                item.existingImageID.map { (item.id, $0) }
            })
        addNew = Dictionary(
            uniqueKeysWithValues: items.compactMap { item in
                guard item.existingImageID == nil, !item.approvedCandidates.isEmpty else { return nil }
                return (item.id, item.approvedCandidates)
            })
    }

    var isDirty: Bool {
        items.contains { item in
            decisions[item.id] != item.existingImageID
                || (addNew[item.id] ?? []) != (item.existingImageID == nil ? item.approvedCandidates : [])
        }
    }

    func chooseExisting(_ imageID: ImageCode, for itemID: String) {
        decisions[itemID] = imageID
        addNew[itemID] = nil
    }

    func chooseNew(for itemID: String, approving candidates: Set<ImageCode>) {
        decisions[itemID] = nil
        addNew[itemID] = candidates
    }

    func approvedNew(for itemID: String, candidates: Set<ImageCode>) -> Bool {
        guard let approved = addNew[itemID] else { return false }
        return candidates.isSubset(of: approved)
    }

    func reviewedItems(candidates: (PhotoSelectionItem) -> [DedupCandidate]) -> [PhotoSelectionItem] {
        items.map { original in
            var item = original
            item.existingImageID = decisions[item.id]
            item.approvedCandidates = Set(candidates(item).map(\.id))
            return item
        }
    }
}

struct PhotoMatchReviewContent: View {
    @Environment(AppModel.self) private var appModel
    @Bindable var draft: PhotoReviewDraft
    let onCancel: () -> Void
    let onContinue: ([PhotoSelectionItem]) -> Void
    @State private var checking = true
    @State private var checkStatus = "Checking selected photos…"
    @State private var error: String?
    @State private var sessionID = UUID()
    @State private var refreshID = UUID()
    @State private var draftDismissal = DraftDismissalState()

    private var items: [PhotoSelectionItem] { draft.items }

    var body: some View {
        List {
            Section {
                PhotoImportHero(items: items)
            }
            Section {
                Text(appModel.photoMatches.coverage)
                if appModel.photoMatches.remainingCount > 0 {
                    Text(
                        "Some Cubby images remain unchecked. You can continue after the selected photos are checked."
                    )
                    .foregroundStyle(.secondary)
                }
                if checking { ProgressView(checkStatus) }
                if let error { Text(error).foregroundStyle(PorcelainTokens.destructive) }
                if appModel.photoMatches.repairFailures > 0 {
                    Text(
                        "\(appModel.photoMatches.repairFailures) images could not be checked. Refresh to retry."
                    )
                    .foregroundStyle(.secondary)
                }
            }
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                Section("Photo \(index + 1)") {
                    Image(decorative: item.preview, scale: 1).resizable().scaledToFit()
                        .frame(maxHeight: 180).frame(maxWidth: .infinity)
                    if let date = item.capturedAt {
                        Text(date.formatted(date: .abbreviated, time: .shortened)).font(.caption)
                    }
                    let matches = candidates(item)
                    if matches.isEmpty {
                        Text(checking ? "Checking for matches…" : "No known match").foregroundStyle(
                            .secondary)
                    } else {
                        ForEach(matches, id: \.id) { candidate in
                            VStack(alignment: .leading, spacing: 8) {
                                MatchCandidateView(candidate: candidate, selections: items)
                                Button {
                                    draft.chooseExisting(candidate.id, for: item.id)
                                } label: {
                                    Label(
                                        "Use this version",
                                        systemImage: draft.decisions[item.id] == candidate.id
                                            ? "checkmark.circle.fill" : "circle")
                                }
                            }
                        }
                        Button {
                            draft.chooseNew(for: item.id, approving: Set(matches.map(\.id)))
                        } label: {
                            Label(
                                "Add this photo instead",
                                systemImage: approvedNew(item) ? "checkmark.circle.fill" : "circle")
                        }
                    }
                }
            }
        }
        .navigationTitle("Review photos")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { cancel() }
                    .accessibilityIdentifier("photos.review.cancel")
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Continue") { finish() }.disabled(!canContinue)
                    .accessibilityIdentifier("photos.review.continue")
            }
            ToolbarItem(placement: .automatic) {
                Button("Check again", systemImage: "arrow.clockwise") { refreshID = UUID() }
                    .disabled(checking)
                    .accessibilityIdentifier("photos.review.refresh")
            }
        }
        .task(id: refreshID) {
            appModel.photoMatches.acquire(sessionID); await check()
        }
        .onDisappear { appModel.photoMatches.release(sessionID) }
        .draftDismissal(
            $draftDismissal, isDirty: isDirty, isSaving: false,
            onDiscard: onCancel)
    }

    private func candidates(_ item: PhotoSelectionItem) -> [DedupCandidate] {
        var seen = Set<ImageCode>()
        return (appModel.photoMatches.candidates[item.id] ?? []).filter { seen.insert($0.id).inserted }
    }

    private func approvedNew(_ item: PhotoSelectionItem) -> Bool {
        draft.approvedNew(for: item.id, candidates: Set(candidates(item).map(\.id)))
    }

    private var canContinue: Bool {
        !checking && error == nil && appModel.photoMatches.hasIndex
            && items.allSatisfy { item in
                candidates(item).isEmpty || candidates(item).contains { $0.id == draft.decisions[item.id] }
                    || approvedNew(item)
            }
    }

    private func check() async {
        checking = true; error = nil
        do {
            try await appModel.photoMatches.check(items, client: appModel.client) { checkStatus = $0 }
        } catch {
            self.error = error.localizedDescription; Diagnostics.report(error, context: "photos.review")
        }
        checking = false
    }

    private func finish() {
        guard canContinue else { return }
        onContinue(draft.reviewedItems(candidates: candidates))
    }

    private var isDirty: Bool {
        draft.isDirty
    }

    private func cancel() {
        draftDismissal.request(isDirty: isDirty, onDiscard: onCancel)
    }
}

struct MatchCandidateView: View {
    @Environment(AppModel.self) private var appModel
    let candidate: DedupCandidate
    var selections: [PhotoSelectionItem] = []
    @State private var detail: ImageWithEntity?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if candidate.id.rawValue.hasPrefix("draft:") {
                if let index = selections.firstIndex(where: { "draft:\($0.id)" == candidate.id.rawValue }) {
                    Text("Also selected as photo \(index + 1)").font(.headline)
                    Image(decorative: selections[index].preview, scale: 1).resizable().scaledToFit().frame(
                        height: 100)
                }
            } else if let detail {
                if let url = detail.imageURL {
                    PhotoAttachmentImage(
                        photo: PhotoAttachment(
                            id: detail.id.rawValue, filename: detail.filename, source: .remote(url)),
                        renderedWidth: 160
                    ).frame(height: 120)
                }
                Text(detail.filename).font(.headline)
                if detail.associations.isEmpty {
                    Text("In Cubby, with no current associations").font(.caption)
                }
                ForEach(detail.associations) { association in
                    Text("\(association.entityName) · \(association.role.rawValue)").font(.caption)
                }
            } else if let error {
                Text(error).foregroundStyle(PorcelainTokens.destructive)
            } else {
                LoadingIndicator(label: "Loading photo details")
            }
            Text(
                candidate.basis == .source
                    ? "Recognized as the source of a Cubby edit" : "Matches a stored Cubby image"
            )
            .font(.caption).foregroundStyle(.secondary)
            Text(
                "\(candidate.confidence == .strong ? "Strong" : "Possible") match · fingerprint distance \(candidate.distance)"
            )
            .font(.caption2).foregroundStyle(.secondary)
        }
        .task(id: candidate.id) {
            guard !candidate.id.rawValue.hasPrefix("draft:") else { return }
            do { detail = try await appModel.client.imageDetail(candidate.id) } catch {
                self.error = error.localizedDescription;
                Diagnostics.report(error, context: "photos.matchDetail")
            }
        }
    }
}

#Preview(traits: .modifier(SignedInPreview())) {
    PhotoMatchReviewSheet(draft: PhotoReviewDraft(items: []), onContinue: { _ in })
}
