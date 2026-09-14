import CubbyKit
import SwiftUI

struct PhotoMatchReviewSheet: View {
    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    let items: [PhotoSelectionItem]
    var dismissOnContinue = true
    let onContinue: ([PhotoSelectionItem]) -> Void
    @State private var decisions: [String: ImageCode] = [:]
    @State private var addNew: [String: Set<ImageCode>] = [:]
    @State private var checking = true
    @State private var error: String?
    @State private var sessionID = UUID()
    @State private var refreshID = UUID()

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(appModel.photoMatches.coverage)
                    if appModel.photoMatches.remainingCount > 0 {
                        Text("You can add now. Images that have not been checked may still be duplicates.")
                            .foregroundStyle(.secondary)
                    }
                    if checking { ProgressView("Checking selected photos…") }
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
                            Text("No known match").foregroundStyle(.secondary)
                        } else {
                            ForEach(matches, id: \.id) { candidate in
                                VStack(alignment: .leading, spacing: 8) {
                                    MatchCandidateView(candidate: candidate, selections: items)
                                    Button {
                                        decisions[item.id] = candidate.id
                                        addNew[item.id] = nil
                                    } label: {
                                        Label(
                                            "Use this version",
                                            systemImage: decisions[item.id] == candidate.id
                                                ? "checkmark.circle.fill" : "circle")
                                    }
                                }
                            }
                            Button {
                                decisions[item.id] = nil
                                addNew[item.id] = Set(matches.map(\.id))
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
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Continue") { finish() }.disabled(!canContinue)
                }
                ToolbarItem(placement: .automatic) {
                    Button("Check again", systemImage: "arrow.clockwise") { refreshID = UUID() }
                        .disabled(checking)
                }
            }
            .task(id: refreshID) {
                appModel.photoMatches.acquire(sessionID); await check()
            }
            .onDisappear { appModel.photoMatches.release(sessionID) }
        }
        #if os(macOS)
            .frame(minWidth: 540, minHeight: 620)
        #endif
    }

    private func candidates(_ item: PhotoSelectionItem) -> [DedupCandidate] {
        var seen = Set<ImageCode>()
        return (appModel.photoMatches.candidates[item.id] ?? []).filter { seen.insert($0.id).inserted }
    }

    private func approvedNew(_ item: PhotoSelectionItem) -> Bool {
        guard let approved = addNew[item.id] else { return false }
        return Set(candidates(item).map(\.id)).isSubset(of: approved)
    }

    private var canContinue: Bool {
        !checking && error == nil && appModel.photoMatches.hasIndex
            && items.allSatisfy { item in
                candidates(item).isEmpty || candidates(item).contains { $0.id == decisions[item.id] }
                    || approvedNew(item)
            }
    }

    private func check() async {
        checking = true; error = nil
        do { try await appModel.photoMatches.check(items, client: appModel.client) } catch {
            self.error = error.localizedDescription; Diagnostics.report(error, context: "photos.review")
        }
        checking = false
    }

    private func finish() {
        guard canContinue else { return }
        let reviewed = items.map { original in
            var item = original
            item.existingImageID = decisions[item.id]
            item.approvedCandidates = Set(candidates(item).map(\.id))
            return item
        }
        onContinue(reviewed)
        if dismissOnContinue { dismiss() }
    }
}

struct MatchCandidateView: View {
    @Environment(AppModel.self) private var appModel
    let candidate: DedupCandidate
    var selections: [PhotoSelectionItem] = []
    @State private var detail: CubbyImageDetail?
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
                PhotoAttachmentImage(
                    photo: PhotoAttachment(
                        id: detail.id.rawValue, filename: detail.filename,
                        source: .remote(detail.url)), renderedWidth: 160
                ).frame(height: 120)
                Text(detail.filename).font(.headline)
                if detail.associations.isEmpty {
                    Text("In Cubby, with no current associations").font(.caption)
                }
                ForEach(detail.associations) { association in
                    Text("\(association.name) · \(association.role)").font(.caption)
                }
            } else if let error {
                Text(error).foregroundStyle(PorcelainTokens.destructive)
            } else {
                ProgressView()
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

#Preview {
    PhotoMatchReviewSheet(items: [], onContinue: { _ in }).environment(PreviewFixtures.signedInModel())
}
