import CubbyKit
import SwiftUI

/// A Run's detail, for every Run purpose: the manifest-declared hero and `run` detail slots
/// (progress, controls, approvals, findings, targets, evidence, transcript, log, photo review,
/// usage, changes) drawn through `DetailSlotRegistry` and `ReportDetailSlot`, the path every
/// detail screen uses. A Run has no native generic `get` read, so the slot host's row is built
/// from the Run's work snapshot (read once, for its purpose) and the status its batched report
/// read returns on every poll — the one poll that keeps the screen live.
///
/// Specialist reviews stay owned flows inside it: a photo Run's review is its `photo-batch`
/// slot (drawn from this screen's `RunReviewSession`, whose approvals stay exactly the frozen,
/// selected ready groups), and a purchase validation's corrections review follows the hero.
struct RunConsoleView: View {
    let runID: String
    private let isPreview: Bool

    @Environment(AppModel.self) private var appModel
    @State private var session: RunReviewSession
    @State private var photoReview = PhotoReviewWorkspace()
    @State private var reportBatches = ReportBatchStore()
    @State private var batch: ReportBatchModel?

    init(runID: String, previewSession: RunReviewSession? = nil) {
        self.runID = runID
        isPreview = previewSession != nil
        _session = State(
            initialValue: previewSession
                ?? RunReviewSession(reportDiagnostic: { error, context in
                    Diagnostics.report(error, context: context)
                }))  // state-init-ok: fixture
    }

    private var descriptor: EntityDescriptor { EntityCatalog[.run] }

    /// The fields the slot registry reads (purpose, status); the title is the purpose's label.
    private func row(_ snapshot: RunWorkSnapshotOutput) -> EntityRow {
        let raw: JSONValue = .object([
            "id": .string(runID),
            "purpose": .string(snapshot.purpose.rawValue),
            // The batch's poll is the live status; the snapshot only seeds it.
            "status": .string(batch?.status ?? snapshot.status.rawValue),
        ])
        let title = descriptor.field("purpose").flatMap {
            EntityFieldValue.text(in: raw, field: $0, surface: "detail")
        }
        return EntityRow(
            id: runID, title: title ?? descriptor.singular, subtitle: nil, imageURL: nil, raw: raw)
    }

    /// The declared slots. A full-width slot is a specialist review — the Run's next action — so
    /// it leads the reports rather than sitting below a long progress log (DESIGN.md: nothing
    /// pushes the next action off the useful first screen).
    private var sections: [DetailSection] {
        let slots = descriptor.presentation.detailSections.filter {
            if case .slot = $0.kind { return true }
            return false
        }
        return slots.filter { $0.placement == .full } + slots.filter { $0.placement != .full }
    }

    var body: some View {
        List {
            if let snapshot = session.snapshot {
                let row = row(snapshot)
                Section {
                    EntityHeroView(descriptor: descriptor, row: row) { EmptyView() }
                    if let error = session.error {
                        InlineLoadFailure(message: error) { await refresh() }
                    }
                    if let error = session.actionError {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(FieldGuideTokens.destructive)
                            .textSelection(.enabled)
                    }
                }
                ForEach(sections) { section in
                    if let view = DetailSlotRegistry.view(slot: section.id, row: row) {
                        // A full-width slot draws its own sections.
                        if section.placement == .full {
                            view
                        } else {
                            Section(section.title ?? "") { view }
                        }
                    }
                }
            } else if let error = session.error {
                Section {
                    LoadFailureView(title: "Couldn’t load run", message: error) { await refresh() }
                }
            } else {
                LoadingIndicator(label: "Loading run")
            }
        }
        .navigationTitle(descriptor.singular)
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .environment(\.reportBatchStore, reportBatches)
        .environment(session)
        .environment(photoReview)
        // Popovers anchored to the list, so each presents once for the whole review.
        .photoReviewConfirmations(photoReview, session: session, runID: runID)
        .refreshable {
            await refresh()
            await batch?.refresh()
        }
        .task(id: runID) { await follow() }
        // Each poll of the batch also re-reads the photo review beside the reports: photo
        // processing and the agent's proposals change while the Run is live.
        .onChange(of: batch?.revision) { _, revision in
            guard (revision ?? 0) > 1, session.snapshot?.purpose == .photoInventory else { return }
            Task { await refresh() }
        }
        // Ordinary session refreshes leave actionRevision unchanged, so the batch's photo
        // refresh cannot feed back into another batch refresh. A stopped Run still redraws
        // after approval; an action that makes it live again also resumes polling.
        .task(id: session.actionRevision) {
            guard session.actionRevision > 0, session.snapshot?.purpose == .photoInventory,
                let batch
            else { return }
            await batch.refresh()
            if batch.live { batch.restartPolling() }
        }
        // A report that read another status (or an action elsewhere) re-reads the batch.
        .task(id: appModel.entityMutationRevision) {
            guard appModel.entityMutationRevision > 0, appModel.entityMutationKeys.contains(.run)
            else { return }
            await batch?.refresh()
        }
    }

    /// Loads the Run, then holds its batched report poll for as long as the screen shows, so the
    /// status and photo review stay live even when every report row has scrolled away.
    private func follow() async {
        guard !isPreview else { return }
        await refresh()
        let batch = reportBatches.batch(service: appModel.client, id: runID, shownStatus: nil)
        self.batch = batch
        batch.retain()
        while !Task.isCancelled { try? await Task.sleep(for: .seconds(3600)) }
        batch.release()
    }

    private func refresh() async {
        await session.refresh(runID: runID, client: appModel.client)
        await photoReview.autoStartGroupingWhenAnalyzed(
            session: session, runID: runID, client: appModel.client)
    }
}

/// `run.photo-batch`: a photo Run's review, drawn from the Run screen's photo session. It is list
/// content (several sections), so the screen places it without a section of its own and carries
/// the review's confirmations.
struct RunPhotoBatchSlot: View {
    let runID: String
    @Environment(RunReviewSession.self) private var session: RunReviewSession?
    @Environment(PhotoReviewWorkspace.self) private var workspace: PhotoReviewWorkspace?

    var body: some View {
        if let session, let workspace {
            RunPhotoReviewSections(runID: runID, session: session, workspace: workspace)
        }
    }
}
// The photo Run the Run, photo-review, candidate and draft previews share.
#if DEBUG
    enum RunReviewPreviewFixture {
        static let runID = "RUN-4K7M"

        @MainActor static func model() -> RunReviewSession {
            let itemID = ImageCode("IMG-2345")
            let labelID = ImageCode("IMG-2346")
            let group = PhotoGroupProposal(
                groupKey: "work-shirt", state: .proposed,
                images: [.init(id: itemID, purpose: .item), .init(id: labelID, purpose: .label)],
                skip: [],
                product: .create(
                    .init(
                        kind: .create,
                        create: .init(name: "Canvas pocket T-shirt · navy", manufacturer: "ForgeWear"))),
                evidence: "The shirt and neck label show one garment. Confirm the size before approval.",
                missingImageCount: 0, updatedAt: "2026-09-24T12:00:00Z")
            let images: [PhotoRunImage] = [
                .init(
                    id: itemID, position: 0, targetState: .pending,
                    originalUrl: "synthetic://shirt", cutout: .ready, describe: .ready,
                    describeStartedAt: .now.addingTimeInterval(-1.3), describeCompletedAt: .now,
                    localAnalysisReady: true, description: "Navy short-sleeve pocket shirt",
                    deviceWorkAttempts: 1),
                .init(
                    id: labelID, position: 1, targetState: .pending,
                    originalUrl: "synthetic://label", cutout: .skipped, describe: .ready,
                    localAnalysisReady: true, cutoutReason: "Label evidence does not need a cutout",
                    description: "Neck label close-up", deviceWorkAttempts: 1),
            ]
            let review = PhotoRunReviewResponse(
                review: PhotoGroupProposalList(
                    runId: runID, runStatus: .running, proposals: [group], unassignedImageIds: []),
                images: images)
            let run = RunWorkSnapshotOutput(
                runId: runID, purpose: .photoInventory, status: .running,
                startedAt: .now.addingTimeInterval(-12), endedAt: nil,
                coordinatorModel: "gpt-6-sol", agentModelMs: 4_200,
                ordersSeen: 0, imported: 0, updated: 0, skipped: 0, findings: [],
                targetsTotal: 2, targetsCompleted: 0, targets: [],
                progress: [
                    .init(phase: "grouping", detail: "Identified one shirt and its label", createdAt: .now)
                ],
                operations: [])
            return RunReviewSession(snapshot: run, review: review)
        }
    }

    #Preview("Photo run", traits: .modifier(SignedInPreview())) {
        NavigationStack {
            RunConsoleView(
                runID: RunReviewPreviewFixture.runID,
                previewSession: RunReviewPreviewFixture.model())
        }
    }

    #Preview("Photo run — wide", traits: .modifier(SignedInPreview())) {
        NavigationStack {
            RunConsoleView(
                runID: RunReviewPreviewFixture.runID,
                previewSession: RunReviewPreviewFixture.model())
        }
        .frame(width: 1360, height: 900)
    }
#endif
