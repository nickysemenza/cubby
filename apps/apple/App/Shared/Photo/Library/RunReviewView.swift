import CubbyKit
import SwiftUI

/// The same run, photo, and proposal state used by the web reviewer. A photo-inventory Run shows
/// its photo review (`RunPhotoReviewSections`); no product is created until the household
/// confirms a proposed group.
struct RunReviewView: View {
    let runID: String
    private let isPreview: Bool

    @Environment(AppModel.self) private var appModel
    @State private var model = RunReviewSession()
    @State private var photoReview = PhotoReviewWorkspace()

    init(runID: String, previewModel: RunReviewSession? = nil) {
        self.runID = runID
        isPreview = previewModel != nil
        _model = State(
            initialValue: previewModel
                ?? RunReviewSession(reportDiagnostic: { error, context in
                    Diagnostics.report(error, context: context)
                }))  // state-init-ok: fixture
    }

    var body: some View {
        List {
            if let snapshot = model.snapshot {
                overview(snapshot)
                if snapshot.purpose == .photoInventory {
                    RunPhotoReviewSections(runID: runID, session: model, workspace: photoReview)
                }
                if snapshot.purpose == .purchaseValidation {
                    PurchaseValidationReviewSection(runID: runID)
                }
                findingsSection(snapshot)
                workTimeline(snapshot)
            } else if let error = model.error {
                Section {
                    LoadFailureView(title: "Couldn’t load run", message: error) { await refresh() }
                }
            } else {
                ProgressView("Loading run…")
            }
        }
        .navigationTitle("Import run")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .refreshable { await refresh() }
        .task(id: runID) {
            guard !isPreview else { return }
            await refresh()
            await autoStartGroupingWhenAnalyzed()
            while !Task.isCancelled, model.snapshot?.status == .running {
                try? await Task.sleep(for: .seconds(3))
                guard !Task.isCancelled else { break }
                await refresh()
                await autoStartGroupingWhenAnalyzed()
            }
        }
        .photoReviewConfirmations(photoReview, session: model, runID: runID)
    }

    @ViewBuilder private func findingsSection(_ snapshot: RunWorkSnapshotOutput) -> some View {
        if let value = try? JSONValue(encoding: snapshot.findings),
            let findings = value.arrayValue, !findings.isEmpty
        {
            RunFindingReviewSection(findings: findings, busy: model.busy, onResolve: resolveFinding)
        }
    }

    private func resolveFinding(_ id: String, apply: Bool, fingerprint: String?) {
        let reviewed = model.document(runID: runID)
        Task {
            let resolved = await model.execute(
                .resolveFinding(
                    reviewed: reviewed, id: id, apply: apply, reviewedFingerprint: fingerprint),
                runID: runID, client: appModel.client)
            if resolved {
                appModel.recordEntityMutation(keys: [.expense, .purchase, .product, .run])
            }
        }
    }

    private func refresh() async {
        await model.refresh(runID: runID, client: appModel.client)
    }

    private func autoStartGroupingWhenAnalyzed() async {
        await photoReview.autoStartGroupingWhenAnalyzed(
            session: model, runID: runID, client: appModel.client)
    }

    private func overview(_ run: RunWorkSnapshotOutput) -> some View {
        Section {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                Text(run.purpose == .photoInventory ? photoReview.stage(model) : "Import progress")
                    .font(.headline)
                HStack {
                    Label(
                        run.status.rawValue.replacingOccurrences(of: "_", with: " ").capitalized,
                        systemImage: run.status == .completed
                            ? "checkmark.circle.fill" : "arrow.triangle.2.circlepath"
                    )
                    .foregroundStyle(run.status == .completed ? FieldGuideTokens.positive : .primary)
                    Spacer()
                    Text(run.runId).font(.caption.monospaced()).foregroundStyle(.secondary)
                }
                .font(.subheadline)
                if run.targetsTotal > 0 {
                    ProgressView(value: Double(run.targetsCompleted), total: Double(run.targetsTotal))
                    Text(
                        run.purpose == .photoInventory
                            ? "\(run.targetsCompleted) of \(run.targetsTotal) photos settled"
                            : "\(run.targetsCompleted) of \(run.targetsTotal) inputs processed"
                    )
                    .font(.caption).foregroundStyle(.secondary)
                }
                if run.purpose != .photoInventory {
                    Text(
                        "\(run.ordersSeen) orders · \(run.imported) imported · \(run.updated) updated · \(run.skipped) skipped"
                    )
                    .font(.caption).foregroundStyle(.secondary)
                }
                if run.purpose != .photoInventory {
                    // The route for a Run is this review screen, so the server-composed console
                    // (progress, approvals, findings, log, usage) is one push away from it.
                    NavigationLink {
                        RunConsoleView(run: run)
                    } label: {
                        Label("Run console", systemImage: "list.bullet.rectangle")
                    }
                }
                if run.status == .pausedAuth || run.status == .pausedOffline {
                    Label(
                        run.status == .pausedAuth
                            ? "Waiting for retailer sign-in" : "Waiting for Mac browser",
                        systemImage: "person.crop.circle.badge.clock"
                    )
                    .font(.subheadline.weight(.medium))
                    Text(
                        run.status == .pausedAuth
                            ? "Finish sign-in in the Cubby-managed Chrome tab on your Mac, then resume this run."
                            : "Reconnect the Cubby Mac browser and leave the retailer tab open before resuming."
                    )
                    .font(.caption).foregroundStyle(.secondary)
                    Link(
                        "Open sign-in and resume controls",
                        destination: appModel.webURL(for: .run, id: runID))
                }
                if let latest = run.progress.last {
                    HStack(alignment: .firstTextBaseline) {
                        Text(
                            latest.detail ?? latest.phase.replacingOccurrences(of: "_", with: " ").capitalized
                        )
                        .lineLimit(2)
                        Spacer(minLength: FieldGuideTokens.Space.sm)
                        Text(latest.createdAt, style: .relative)
                            .fixedSize().foregroundStyle(.secondary)
                    }
                    .font(.caption)
                }
                if let error = model.error {
                    InlineLoadFailure(message: error) { await refresh() }
                }
                if let error = model.actionError {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(FieldGuideTokens.destructive)
                }
            }
        } header: {
            Text("Run")
        }
    }

    private func workTimeline(_ run: RunWorkSnapshotOutput) -> some View {
        Section("Work at a glance") {
            TimelineView(.periodic(from: .now, by: 1)) { timeline in
                HStack {
                    Label("Elapsed", systemImage: "clock")
                    Spacer()
                    Text(
                        Duration.seconds(
                            max(0, (run.endedAt ?? timeline.date).timeIntervalSince(run.startedAt))
                        ).formatted()
                    )
                    .monospacedDigit()
                }
            }
            if let coordinatorModel = run.coordinatorModel, run.agentModelMs > 0 || model.usage != nil {
                HStack {
                    Label {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Model time")
                            Text(coordinatorModel).font(.caption).foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: "sparkles")
                    }
                    Spacer()
                    Text(Duration.milliseconds(run.agentModelMs).formatted())
                        .monospacedDigit()
                }
                .accessibilityLabel("Model time: \(coordinatorModel)")
            }
            if let usage = model.usage {
                HStack {
                    Label("AI spend", systemImage: "dollarsign.circle")
                    Spacer()
                    Text(usage.pricedSubtotal, format: .usd)
                        .monospacedDigit()
                }
                if usage.unpricedCount > 0 {
                    Text("\(usage.unpricedCount) AI calls have no price yet.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            } else if let usageError = model.usageError {
                Text(usageError).font(.caption).foregroundStyle(FieldGuideTokens.warning)
            }
            if run.purpose == .photoInventory {
                let images = model.review?.images ?? []
                workStage("Receive photos", done: !images.isEmpty, detail: "\(images.count) received")
                workStage(
                    "Process photos",
                    done: !images.isEmpty
                        && images.allSatisfy { $0.describe == .ready || $0.describe == .skipped },
                    detail: "Device, cutout and description run in the background"
                )
                workStage(
                    "Prepare item groups",
                    done: !(model.review?.review.proposals.isEmpty ?? true),
                    detail: "Agent proposes which photos belong together"
                )
                workStage(
                    "Review and save",
                    done: run.targetsTotal > 0 && run.targetsCompleted == run.targetsTotal,
                    detail: "Products are created or linked after approval"
                )
            } else {
                workStage(
                    "Read source", done: !run.progress.isEmpty, detail: "Collect order or account evidence")
                workStage("Extract orders", done: run.ordersSeen > 0, detail: "\(run.ordersSeen) found")
                workStage(
                    "Review and save", done: run.status == .completed, detail: "\(run.imported) imported")
            }
            DisclosureGroup("Technical timeline") {
                if run.progress.isEmpty && run.operations.isEmpty {
                    Text("No events recorded yet.").foregroundStyle(.secondary)
                }
                ForEach(Array(run.progress.enumerated()), id: \.offset) { _, step in
                    VStack(alignment: .leading) {
                        Text(step.phase.replacingOccurrences(of: "_", with: " ").capitalized)
                        if let detail = step.detail {
                            Text(detail).font(.caption).foregroundStyle(.secondary)
                        }
                        Text(step.createdAt, format: .dateTime.hour().minute().second())
                            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }
                }
                ForEach(Array(run.operations.enumerated()), id: \.offset) { _, operation in
                    VStack(alignment: .leading) {
                        Text(operation.kind.replacingOccurrences(of: "_", with: " ").capitalized)
                        Text(operation.state.capitalized).font(.caption).foregroundStyle(.secondary)
                        if let end = operation.completedAt {
                            Text(
                                "\(end.timeIntervalSince(operation.startedAt).formatted(.number.precision(.fractionLength(1)))) seconds"
                            )
                            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                        if let error = operation.error {
                            Text(error).font(.caption).foregroundStyle(FieldGuideTokens.destructive)
                        }
                    }
                }
            }
        }
    }

    private func workStage(_ title: String, done: Bool, detail: String) -> some View {
        HStack(alignment: .top, spacing: FieldGuideTokens.Space.sm) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle.dotted")
                .foregroundStyle(done ? FieldGuideTokens.positive : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.medium))
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

// Reusable by Xcode Preview and the simulator's synthetic review launch mode.
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
                targetsTotal: 2, targetsCompleted: 0,
                progress: [
                    .init(phase: "grouping", detail: "Identified one shirt and its label", createdAt: .now)
                ],
                operations: [])
            return RunReviewSession(snapshot: run, review: review)
        }
    }

    #Preview("Photo review", traits: .modifier(SignedInPreview())) {
        NavigationStack {
            RunReviewView(
                runID: RunReviewPreviewFixture.runID,
                previewModel: RunReviewPreviewFixture.model())
        }
    }

    #Preview("Photo review — intermediate", traits: .modifier(SignedInPreview())) {
        NavigationStack {
            RunReviewView(
                runID: RunReviewPreviewFixture.runID,
                previewModel: RunReviewPreviewFixture.model())
        }
        .frame(width: 760, height: 900)
    }

    #Preview("Photo review — wide", traits: .modifier(SignedInPreview())) {
        NavigationStack {
            RunReviewView(
                runID: RunReviewPreviewFixture.runID,
                previewModel: RunReviewPreviewFixture.model())
        }
        .frame(width: 1360, height: 900)
    }
#endif
