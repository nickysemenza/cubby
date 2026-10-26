import CubbyKit
import SwiftUI

/// A Run's detail, for every Run purpose: the manifest-declared hero and `run` detail slots
/// (progress, controls, approvals, findings, targets, evidence, transcript, log, usage, changes)
/// drawn through `DetailSlotRegistry` and `ReportDetailSlot`, the path every detail screen uses.
/// A Run has no native generic `get` read, so the slot host's row is built from the Run's work
/// snapshot (read once, for its purpose) and the status its batched report read returns on every
/// poll — the one poll that keeps the screen live.
///
/// A photo Run adds its processing section (upload, descriptions, recovery, starting grouping);
/// reviewing its proposed groups is web's, so its `photo-batch` slot is a handoff row. A purchase
/// validation's corrections review follows the hero.
struct RunConsoleView: View {
    let runID: String
    private let isPreview: Bool

    @Environment(AppModel.self) private var appModel
    @State private var session: RunConsoleSession
    @State private var reportBatches = ReportBatchStore()
    @State private var batch: ReportBatchModel?

    init(runID: String, previewSession: RunConsoleSession? = nil) {
        self.runID = runID
        isPreview = previewSession != nil
        _session = State(
            initialValue: previewSession
                ?? RunConsoleSession(reportDiagnostic: { error, context in
                    Diagnostics.report(error, context: context)
                }))  // state-init-ok: fixture
    }

    private var descriptor: EntityDescriptor { EntityCatalog[.run] }

    /// The fields the slot registry reads (purpose, status); the title is the purpose's label.
    private func row(_ snapshot: RunSnapshot) -> EntityRow {
        var values = snapshot.raw.objectValue ?? [:]
        values["id"] = .string(runID)
        values["purpose"] = .string(snapshot.purpose.rawValue)
        // The batch's poll is the live status; the snapshot only seeds it.
        values["status"] = .string(batch?.status ?? snapshot.status.rawValue)
        let raw = JSONValue.object(values)
        let title = descriptor.field("purpose").flatMap {
            EntityFieldValue.text(in: raw, field: $0, surface: "detail")
        }
        return EntityRow(
            id: runID, title: title ?? descriptor.singular, subtitle: nil, imageURL: nil, raw: raw)
    }

    /// The declared slots. A full-width slot is a specialist review — the Run's next action — so
    /// it leads the reports rather than sitting below a long progress log (DESIGN.md: nothing
    /// pushes the next action off the useful first screen). A handed-off one keeps that lead as
    /// its web row.
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
                    EntityHeroView(descriptor: descriptor, row: row, showsTitle: true) { EmptyView() }
                    if let error = session.error {
                        InlineLoadFailure(message: error) { await refresh() }
                    }
                    if let error = session.actionError {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(FieldGuideTokens.destructive)
                            .textSelection(.enabled)
                    }
                }
                if !descriptor.presentation.summarySlots.isEmpty {
                    Section { DetailSummaryGrid(descriptor: descriptor, row: row) }
                }
                if snapshot.purpose == .photoInventory {
                    RunPhotoProgressSection(runID: runID, session: session)
                }
                ForEach(sections) { section in
                    if let view = DetailSlotRegistry.view(slot: section.id, row: row) {
                        // A full-width native slot draws its own sections; a handoff is one row.
                        if section.placement == .full,
                            NativePresentationCoverage.detailSlot(section.id) == .implemented
                        {
                            Section {
                            } header: {
                                Text(section.title ?? section.id)
                                    .detailContentsHeader().detailContentsAnchor(section.id)
                            }
                            view
                        } else {
                            ContinuousDetailSection(title: section.title ?? "") { view }.detailContentsAnchor(
                                section.id)
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
        .modifier(
            DetailContentsNavigation(
                entries: sections.map {
                    .init(id: $0.id, title: $0.title ?? $0.id, group: "Run")
                })
        )
        .fieldGuideDetailDensity()
        .fieldGuideScreen()
        .accessibilityIdentifier("run.console")
        .navigationTitle(descriptor.singular)
        .toolbar { ToolbarItem { RunEvidenceLink(runID: runID) } }
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .environment(\.reportBatchStore, reportBatches)
        .refreshControl {
            await refresh()
            await batch?.refresh()
        }
        .task(id: runID) { await follow() }
        // Each poll of the batch also re-reads photo processing beside the reports: descriptions
        // and the lifecycle change while the Run is live.
        .onChange(of: batch?.revision) { _, revision in
            guard (revision ?? 0) > 1 else { return }
            Task { await refresh() }
        }
        // Ordinary session refreshes leave actionRevision unchanged, so the batch's photo
        // refresh cannot feed back into another batch refresh. Starting grouping makes the Run
        // live again, so it also resumes polling.
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
    /// status and photo processing stay live even when every report row has scrolled away.
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
        await session.autoStartGroupingWhenAnalyzed(runID: runID, client: appModel.client)
    }
}

#if DEBUG
    enum RunConsolePreviewFixture {
        static let runID = "RUN-4K7M"

        @MainActor static func model() -> RunConsoleSession {
            let itemID = ImageCode("IMG-2345")
            let labelID = ImageCode("IMG-2346")
            let group = PhotoGroupProposal(
                groupKey: "work-shirt",
                steps: [
                    .init(
                        key: "product", label: "Product", status: .done, summary: "Canvas pocket T-shirt",
                        action: nil, blockedReason: nil),
                    .init(
                        key: "identity", label: "Details", status: .needsInput, summary: nil, action: nil,
                        blockedReason: nil),
                    .init(
                        key: "ownership", label: "Own it now?", status: .done, summary: "Reference only",
                        action: nil, blockedReason: nil),
                ],
                blockedReason: nil,
                review: .init(
                    observedName: "Canvas pocket T-shirt · navy", unresolvedReason: nil,
                    stockIntent: .evidence),
                state: .proposed,
                images: [.init(id: itemID, purpose: .item), .init(id: labelID, purpose: .label)],
                skip: [],
                product: .create(
                    .init(
                        kind: .create,
                        create: .init(name: "Canvas pocket T-shirt · navy", brandId: .value("VEN-2345")))),
                committedProduct: nil, inventory: nil,
                evidence: "The shirt and neck label show one garment with matching identity.",
                origin: nil, conflict: nil, lastError: nil, missingImageCount: 0, committedAt: nil,
                updatedAt: "2026-09-24T12:00:00Z")
            let images: [PhotoRunImage] = [
                .init(
                    id: itemID, position: 0, capturedAt: nil, capturedAtOffsetMinutes: nil,
                    targetState: .pending, skipReason: nil,
                    originalUrl: "synthetic://shirt", cutoutUrl: nil, cutout: .ready, describe: .ready,
                    cloudDescriptionMissing: false,
                    describeStartedAt: .now.addingTimeInterval(-1.3), describeCompletedAt: .now,
                    describeAttemptMs: nil, describeWaitingMs: nil,
                    localAnalysisReady: true, cutoutReason: nil, describeReason: nil,
                    description: "Navy short-sleeve pocket shirt",
                    recognizedText: nil, deviceWorkState: nil, deviceWorkError: nil, deviceWorkAttempts: 1),
                .init(
                    id: labelID, position: 1, capturedAt: nil, capturedAtOffsetMinutes: nil,
                    targetState: .pending, skipReason: nil,
                    originalUrl: "synthetic://label", cutoutUrl: nil, cutout: .skipped, describe: .ready,
                    cloudDescriptionMissing: false,
                    describeStartedAt: nil, describeCompletedAt: nil, describeAttemptMs: nil,
                    describeWaitingMs: nil,
                    localAnalysisReady: true, cutoutReason: "Label evidence does not need a cutout",
                    describeReason: nil,
                    description: "Neck label close-up", recognizedText: nil, deviceWorkState: nil,
                    deviceWorkError: nil, deviceWorkAttempts: 1),
            ]
            let review = PhotoRunReviewResponse(
                review: PhotoGroupProposalList(
                    runId: runID, runStatus: .running, proposals: [group], unassignedImageIds: []),
                images: images,
                lifecycle: .init(
                    processor: .cubby, phase: .readyForReview, plannedImageCount: 2,
                    openBatchCount: 0, finalizedImageCount: 2, describedImageCount: 2,
                    failedImageIds: [], withoutCloudDescriptionCount: 0, skippedImageCount: 0,
                    proposedGroupCount: 1, committedGroupCount: 0, dispatchError: nil))
            let run = try! RunSnapshot([
                "runId": .string(runID), "purpose": "photo_inventory", "status": "running",
                "findings": [], "operations": [],
            ])
            return RunConsoleSession(snapshot: run, review: review)
        }
    }

    #Preview("Photo run", traits: .modifier(SignedInPreview())) {
        NavigationStack {
            RunConsoleView(
                runID: RunConsolePreviewFixture.runID,
                previewSession: RunConsolePreviewFixture.model())
        }
    }

    #Preview("Photo run — wide", traits: .modifier(SignedInPreview())) {
        NavigationStack {
            RunConsoleView(
                runID: RunConsolePreviewFixture.runID,
                previewSession: RunConsolePreviewFixture.model())
        }
        .frame(width: 1360, height: 900)
    }
#endif
