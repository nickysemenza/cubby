import CubbyKit
import SwiftUI

@MainActor
@Observable
final class ImportRunReviewModel {
    private(set) var snapshot: RunWorkSnapshotOutput?
    private(set) var review: PhotoRunReviewResponse?
    private(set) var usage: AiRunUsageOut?
    private(set) var usageError: String?
    private(set) var error: String?
    private(set) var actionError: String?
    private(set) var busy = false

    init(snapshot: RunWorkSnapshotOutput? = nil, review: PhotoRunReviewResponse? = nil) {
        self.snapshot = snapshot
        self.review = review
    }

    func refresh(runID: String, client: CubbyClient) async {
        do {
            async let usageRequest = client.runAiUsage(runID)
            let next = try await client.runWorkSnapshot(runID)
            snapshot = next
            error = nil
            if next.purpose == .photoInventory {
                review = try await client.photoRunReview(runID)
            }
            do {
                usage = try await usageRequest
                usageError = nil
            } catch {
                Diagnostics.report(error, context: "Load run AI usage")
                usageError = error.localizedDescription
            }
        } catch {
            Diagnostics.report(error, context: "Load import run review")
            self.error = error.localizedDescription
        }
    }

    func act(
        runID: String, client: CubbyClient,
        operation: @escaping () async throws -> Void
    ) async {
        guard !busy else { return }
        busy = true
        actionError = nil
        defer { busy = false }
        do {
            try await operation()
            await refresh(runID: runID, client: client)
        } catch {
            Diagnostics.report(error, context: "Update photo import run")
            actionError = error.localizedDescription
        }
    }
}

/// Whether the "Start grouping" action belongs on screen, and what to say instead when it
/// doesn't. Zero photos and mid-processing both hide the action — grouping needs settled
/// descriptions to work from, not just an upload.
enum PhotoGroupingReadiness: Equatable {
    /// No photos have arrived yet; nothing to group.
    case waitingForPhotos
    /// Photos arrived but device/description processing hasn't settled for all of them.
    case processing
    /// Photos are uploaded and described; the agent can be started.
    case readyToStart
    /// The agent already stopped short of proposing groups; review continues on the web.
    case needsReviewOnWeb
    /// The agent is between stages (already asked to start, or run isn't `.running`).
    case working

    var message: String {
        switch self {
        case .waitingForPhotos: "Waiting for photos to upload."
        case .processing: "Photos are processing. Grouping starts once descriptions are ready."
        case .readyToStart: "Photos are ready for the agent to propose item groups."
        case .needsReviewOnWeb: "The agent stopped before proposing groups. Review these photos on the web."
        case .working: "Photos uploaded; the agent is preparing item groups."
        }
    }
}

enum PhotoReviewPolicy {
    /// A photo counts as settled for grouping once its description job reaches a terminal state
    /// (ready, skipped, or failed) — `.pending`/`.leased`/`.waitingForDevice` mean grouping would
    /// start from incomplete evidence.
    static func groupingReadiness(
        images: [PhotoRunImage], runStatus: ImportRunStatus?
    ) -> PhotoGroupingReadiness {
        guard !images.isEmpty else { return .waitingForPhotos }
        if runStatus == .needsReview { return .needsReviewOnWeb }
        let settled = images.allSatisfy {
            $0.describe == .ready || $0.describe == .skipped || $0.describe == .failed
        }
        guard settled else { return .processing }
        return runStatus == .running ? .readyToStart : .working
    }

    static func approvalBlocker(
        group: PhotoGroupProposal, images: [PhotoRunImage], runStatus: ImportRunStatus?
    ) -> String? {
        if group.missingImageCount > 0 { return "Some photos are missing; remove them before approval." }
        let byID = Dictionary(uniqueKeysWithValues: images.map { ($0.id, $0) })
        if (group.images.map(\.id) + group.skip.map(\.id)).contains(where: {
            guard let state = byID[$0]?.targetState else { return false }
            return state != .pending && !(runStatus == .needsReview && state == .unresolved)
        }) {
            return "A photo has already been settled outside this group."
        }
        if group.images.contains(where: {
            guard let state = byID[$0.id]?.describe else { return false }
            return state == .pending || state == .waitingForDevice || state == .leased || state == .failed
        }) {
            return
                "Approval waits for AI descriptions. Device analysis and cutouts may continue in the background."
        }
        if case .existing(let product) = group.product, product.existing == nil {
            return "Select an existing product before approval."
        }
        return nil
    }
}

/// The same run, photo, and proposal state used by the web reviewer. No product is created until
/// the household confirms a proposed group.
struct ImportRunReviewView: View {
    let runID: String
    private let isPreview: Bool

    @Environment(AppModel.self) private var appModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var model = ImportRunReviewModel()
    @State private var confirmingGroup: String?
    @State private var confirmingAll = false
    @State private var discardingGroup: String?
    @State private var autoStartAttempted = false
    @State private var selectedGroupKey: String?

    init(runID: String, previewModel: ImportRunReviewModel? = nil) {
        self.runID = runID
        isPreview = previewModel != nil
        _model = State(initialValue: previewModel ?? ImportRunReviewModel())  // state-init-ok: fixture
    }

    private var proposed: [PhotoGroupProposal] {
        model.review?.review.proposals.filter { $0.state == .proposed } ?? []
    }

    private var photoStage: String {
        guard let review = model.review else { return "Loading photos" }
        if model.snapshot?.status == .completed { return "Review complete" }
        if !proposed.isEmpty {
            return "\(proposed.count) item \(proposed.count == 1 ? "group" : "groups") ready for review"
        }
        if review.images.isEmpty { return "Waiting for photos to upload" }
        if model.snapshot?.status == .needsReview { return "Agent stopped; photos need review" }
        if model.actionError != nil { return "Grouping needs attention" }
        if !autoStartAttempted { return "Photos uploaded; ready to group" }
        return "Agent is preparing item groups"
    }

    var body: some View {
        List {
            if let snapshot = model.snapshot {
                overview(snapshot)
                if snapshot.purpose == .photoInventory {
                    photoReview
                }
                workTimeline(snapshot)
            } else if let error = model.error {
                Section {
                    ContentUnavailableView(
                        "Couldn’t load run", systemImage: "exclamationmark.triangle", description: Text(error)
                    )
                    Button("Retry") { Task { await refresh() } }
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
            if !autoStartAttempted,
                model.snapshot?.status == .running,
                let review = model.review,
                !review.images.isEmpty,
                review.review.proposals.isEmpty
            {
                autoStartAttempted = true
                await model.act(runID: runID, client: appModel.client) {
                    try await appModel.client.startPhotoGrouping(runID)
                }
            }
            while !Task.isCancelled, model.snapshot?.status == .running {
                try? await Task.sleep(for: .seconds(3))
                guard !Task.isCancelled else { break }
                await refresh()
            }
        }
        .confirmationDialog(
            "Approve this item?",
            isPresented: Binding(
                get: { confirmingGroup != nil },
                set: { if !$0 { confirmingGroup = nil } }
            )
        ) {
            if let group = confirmingGroup {
                Button("Create or link product") { approve([group]) }
            }
        } message: {
            Text("This attaches the photos and commits the proposed product choice.")
        }
        .confirmationDialog("Approve all proposed items?", isPresented: $confirmingAll) {
            Button("Approve \(proposed.count) items") { approve(proposed.map(\.groupKey)) }
        }
        .confirmationDialog(
            "Discard this item?",
            isPresented: Binding(
                get: { discardingGroup != nil },
                set: { if !$0 { discardingGroup = nil } }
            )
        ) {
            if let group = discardingGroup {
                Button("Discard proposal", role: .destructive) {
                    Task {
                        await model.act(runID: runID, client: appModel.client) {
                            _ = try await appModel.client.discardPhotoGroup(runID: runID, groupKey: group)
                        }
                    }
                }
            }
        }
    }

    private func refresh() async {
        await model.refresh(runID: runID, client: appModel.client)
    }

    private func approve(_ keys: [String]) {
        guard !keys.isEmpty else { return }
        Task {
            await model.act(runID: runID, client: appModel.client) {
                _ = try await appModel.client.approvePhotoGroups(runID: runID, groupKeys: keys)
            }
        }
    }

    private func overview(_ run: RunWorkSnapshotOutput) -> some View {
        Section {
            VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
                Text(run.purpose == .photoInventory ? photoStage : "Import progress")
                    .font(.headline)
                HStack {
                    Label(
                        run.status.rawValue.replacingOccurrences(of: "_", with: " ").capitalized,
                        systemImage: run.status == .completed
                            ? "checkmark.circle.fill" : "arrow.triangle.2.circlepath"
                    )
                    .foregroundStyle(run.status == .completed ? PorcelainTokens.positive : .primary)
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
                        destination: appModel.webURL(for: .importRun, id: runID))
                }
                if let latest = run.progress.last {
                    HStack(alignment: .firstTextBaseline) {
                        Text(
                            latest.detail ?? latest.phase.replacingOccurrences(of: "_", with: " ").capitalized
                        )
                        .lineLimit(2)
                        Spacer(minLength: PorcelainTokens.Space.sm)
                        Text(latest.createdAt, style: .relative)
                            .fixedSize().foregroundStyle(.secondary)
                    }
                    .font(.caption)
                }
                if let error = model.error {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(PorcelainTokens.warning)
                    Button("Retry") { Task { await refresh() } }
                }
                if let error = model.actionError {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(PorcelainTokens.destructive)
                }
            }
        } header: {
            Text("Run")
        }
    }

    @ViewBuilder private var photoReview: some View {
        if let review = model.review {
            Section {
                photoProcessing(review.images)
                if proposed.isEmpty, review.review.proposals.isEmpty {
                    let readiness = PhotoReviewPolicy.groupingReadiness(
                        images: review.images, runStatus: model.snapshot?.status)
                    Text(readiness.message).foregroundStyle(.secondary)
                    switch readiness {
                    case .needsReviewOnWeb:
                        Link("Group photos on web", destination: appModel.webURL(for: .importRun, id: runID))
                    case .readyToStart:
                        Button {
                            Task {
                                await model.act(runID: runID, client: appModel.client) {
                                    try await appModel.client.startPhotoGrouping(runID)
                                }
                            }
                        } label: {
                            Label("Start grouping", systemImage: "sparkles")
                        }
                        .disabled(model.busy)
                    case .waitingForPhotos, .processing, .working:
                        EmptyView()
                    }
                }
            } header: {
                Text("Photo processing")
            }

            if !proposed.isEmpty {
                Section {
                    reviewWorkspace(review)
                } header: {
                    HStack {
                        Text("Proposed items · \(proposed.count)")
                        Spacer()
                        Button("Approve all") { confirmingAll = true }
                            .disabled(
                                model.busy
                                    || proposed.contains {
                                        approvalBlocker($0, images: review.images) != nil
                                    })
                    }
                } footer: {
                    Text("Products are created or linked only after approval.")
                }
            }

            let settled = review.review.proposals.filter { $0.state != .proposed }
            if !settled.isEmpty {
                Section("Settled items") {
                    ForEach(settled, id: \.groupKey) { group in
                        if let product = group.committedProduct {
                            NavigationLink {
                                EntityDetailView(key: .product, id: product.id.rawValue)
                            } label: {
                                Label(product.name, systemImage: "checkmark.circle")
                            }
                        } else {
                            Label(groupName(group), systemImage: "xmark.circle")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }

            if proposed.isEmpty, !review.images.isEmpty {
                Section("Photos") { evidenceRegion(review.images) }
            }
        }
    }

    private func reviewWorkspace(_ review: PhotoRunReviewResponse) -> some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                stackedReviewWorkspace(review.images)
                    .frame(maxWidth: 720, alignment: .leading)
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: PorcelainTokens.Space.lg) {
                        groupRegion
                            .frame(width: 190, alignment: .topLeading)
                        decisionRegion(review.images)
                            .frame(width: 340, alignment: .topLeading)
                        evidenceRegion(review.images)
                            .frame(width: 260, alignment: .topLeading)
                    }
                    .frame(minWidth: 822, alignment: .leading)

                    stackedReviewWorkspace(review.images)
                }
                .frame(maxWidth: 1180, alignment: .leading)
            }
        }
        .accessibilityIdentifier("review.workspace")
    }

    private func stackedReviewWorkspace(_ images: [PhotoRunImage]) -> some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.lg) {
            groupRegion
            decisionRegion(images)
            evidenceRegion(images)
        }
    }

    private var selectedProposal: PhotoGroupProposal? {
        proposed.first { $0.groupKey == selectedGroupKey } ?? proposed.first
    }

    private var groupRegion: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            Text("Groups").font(.headline)
            ForEach(proposed, id: \.groupKey) { group in
                Button {
                    selectedGroupKey = group.groupKey
                } label: {
                    HStack {
                        Text(groupName(group)).lineLimit(2)
                        Spacer(minLength: 4)
                        if selectedProposal?.groupKey == group.groupKey {
                            Image(systemName: "checkmark").accessibilityHidden(true)
                        }
                    }
                    .frame(minHeight: PorcelainTokens.touchTarget, alignment: .leading)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selectedProposal?.groupKey == group.groupKey ? .isSelected : [])
            }
        }
        .accessibilityIdentifier("review.groups")
    }

    @ViewBuilder private func decisionRegion(_ images: [PhotoRunImage]) -> some View {
        if let group = selectedProposal {
            VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
                Text("Product decision").font(.headline)
                proposal(group, images: images)
            }
            .accessibilityIdentifier("review.decision")
        }
    }

    private func evidenceRegion(_ images: [PhotoRunImage]) -> some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            Text("Photo evidence · \(images.count)").font(.headline)
            ForEach(images, id: \.id) { image in
                HStack(alignment: .top, spacing: PorcelainTokens.Space.sm) {
                    Thumb(url: URL(string: image.originalUrl), size: 58)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(
                            image.description
                                ?? "Photo \(image.position.map { String($0 + 1) } ?? image.id.rawValue)"
                        )
                        .font(.subheadline).lineLimit(3)
                        Label(
                            image.localAnalysisReady ? "Device ready" : "Device analysis pending",
                            systemImage: image.localAnalysisReady ? "checkmark.circle" : "clock")
                        processingLabel("Cutout", state: image.cutout, reason: image.cutoutReason)
                        processingLabel("AI description", state: image.describe, reason: image.describeReason)
                    }
                    .font(.caption)
                }
                Divider()
            }
        }
        .accessibilityIdentifier("review.evidence")
    }

    private func photoProcessing(_ images: [PhotoRunImage]) -> some View {
        let described = images.filter { $0.describe == .ready || $0.describe == .skipped }.count
        let cutouts = images.filter { $0.cutout == .ready || $0.cutout == .skipped }.count
        let deviceDone = images.filter(\.localAnalysisReady).count
        return VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: PorcelainTokens.Space.xl) {
                    processingCount("Device · optional", done: deviceDone, total: images.count)
                    processingCount("Description", done: described, total: images.count)
                    processingCount("Lift · optional", done: cutouts, total: images.count)
                }
                VStack(alignment: .leading) {
                    processingCount("Device · optional", done: deviceDone, total: images.count)
                    processingCount("Description", done: described, total: images.count)
                    processingCount("Lift · optional", done: cutouts, total: images.count)
                }
            }
            if !images.isEmpty,
                images.allSatisfy({ $0.describe == .ready }),
                let first = images.compactMap(\.describeStartedAt).min(),
                let last = images.compactMap(\.describeCompletedAt).max()
            {
                Text(
                    "Described \(images.count) photos in \(last.timeIntervalSince(first).formatted(.number.precision(.fractionLength(1)))) seconds"
                )
                .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func processingCount(_ title: String, done: Int, total: Int) -> some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
            Text(title).font(.caption2).foregroundStyle(.secondary)
            Text("\(done)/\(total)").font(.subheadline.weight(.semibold)).monospacedDigit()
        }
    }

    private func proposal(_ group: PhotoGroupProposal, images: [PhotoRunImage]) -> some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            Text(groupName(group)).font(.headline)
            ScrollView(.horizontal) {
                HStack(spacing: PorcelainTokens.Space.sm) {
                    ForEach(group.images, id: \.id) { item in
                        if let image = images.first(where: { $0.id == item.id }) {
                            VStack(spacing: 2) {
                                Thumb(url: URL(string: image.originalUrl), size: 72)
                                Text(item.purpose.rawValue.capitalized).font(.caption2)
                            }
                        }
                    }
                }
            }
            .scrollIndicators(.hidden)
            if let evidence = group.evidence, !evidence.isEmpty {
                Text(evidence).font(.subheadline).foregroundStyle(.secondary).lineLimit(4)
            }
            if group.missingImageCount > 0 {
                Label(
                    "\(group.missingImageCount) photos are missing", systemImage: "exclamationmark.triangle"
                )
                .foregroundStyle(PorcelainTokens.warning)
            }
            if let blocker = approvalBlocker(group, images: images) {
                Text(blocker).font(.caption).foregroundStyle(PorcelainTokens.warning)
            }
            if let error = group.lastError {
                Text(error).foregroundStyle(PorcelainTokens.destructive)
            }
            NavigationLink {
                PhotoCandidateSelectionView(runID: runID, group: group, images: images) {
                    Task { await refresh() }
                }
            } label: {
                Label("Compare possible matches", systemImage: "square.stack.3d.up")
            }
            if case .create = group.product {
                NavigationLink {
                    PhotoGroupDraftEditView(runID: runID, group: group) {
                        Task { await refresh() }
                    }
                } label: {
                    Label("Edit proposed product", systemImage: "pencil")
                }
            }
            HStack {
                Button("Approve") { confirmingGroup = group.groupKey }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.busy || approvalBlocker(group, images: images) != nil)
                Button("Discard", role: .destructive) { discardingGroup = group.groupKey }
                    .disabled(model.busy)
            }
        }
        .padding(.vertical, PorcelainTokens.Space.xs)
    }

    private func groupName(_ group: PhotoGroupProposal) -> String {
        switch group.product {
        case .create(let product): product.create.name
        case .existing(let product): product.existing?.name ?? "Existing product"
        }
    }

    private func approvalBlocker(_ group: PhotoGroupProposal, images: [PhotoRunImage]) -> String? {
        PhotoReviewPolicy.approvalBlocker(
            group: group, images: images, runStatus: model.review?.review.runStatus)
    }

    private func processingLabel(_ name: String, state: ImageProcessingJobState?, reason: String?)
        -> some View
    {
        let title: String
        let symbol: String
        switch state {
        case .ready: (title, symbol) = ("Done", "checkmark.circle")
        case .skipped: (title, symbol) = ("Skipped", "minus.circle")
        case .failed: (title, symbol) = ("Failed", "exclamationmark.triangle")
        case .waitingForDevice: (title, symbol) = ("Waiting for device", "iphone")
        case .leased: (title, symbol) = ("Working", "hourglass")
        case .pending, nil: (title, symbol) = ("Queued", "clock")
        }
        return VStack(alignment: .leading, spacing: 2) {
            Label("\(name): \(title)", systemImage: symbol)
                .foregroundStyle(state == .ready ? PorcelainTokens.positive : .secondary)
            if let reason, !reason.isEmpty { Text(reason).foregroundStyle(.secondary) }
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
                    Text(usage.pricedSubtotal, format: .currency(code: "USD"))
                        .monospacedDigit()
                }
                if usage.unpricedCount > 0 {
                    Text("\(usage.unpricedCount) AI calls have no price yet.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            } else if let usageError = model.usageError {
                Text(usageError).font(.caption).foregroundStyle(PorcelainTokens.warning)
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
                            Text(error).font(.caption).foregroundStyle(PorcelainTokens.destructive)
                        }
                    }
                }
            }
        }
    }

    private func workStage(_ title: String, done: Bool, detail: String) -> some View {
        HStack(alignment: .top, spacing: PorcelainTokens.Space.sm) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle.dotted")
                .foregroundStyle(done ? PorcelainTokens.positive : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.medium))
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

private struct PhotoCandidateSelectionView: View {
    let runID: String
    let group: PhotoGroupProposal
    let images: [PhotoRunImage]
    let onChosen: () -> Void

    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var candidates: [PhotoProductCandidate] = []
    @State private var error: String?
    @State private var loading = true
    @State private var choosing = false
    @State private var searchingAll = false
    @State private var previewCandidate: PhotoProductCandidate?

    var body: some View {
        List {
            Section("Your photos") {
                ScrollView(.horizontal) {
                    HStack(spacing: PorcelainTokens.Space.sm) {
                        ForEach(group.images, id: \.id) { item in
                            if let image = images.first(where: { $0.id == item.id }) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Thumb(url: URL(string: image.originalUrl), size: 96)
                                    Text(item.purpose.rawValue.capitalized)
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
                .scrollIndicators(.hidden)
                ForEach(group.images, id: \.id) { item in
                    if let image = images.first(where: { $0.id == item.id }),
                        let text = image.recognizedText, !text.isEmpty
                    {
                        DisclosureGroup("Text read from \(item.purpose.rawValue) photo") {
                            Text(text).font(.caption).textSelection(.enabled)
                            Text("Check the photo before using unclear letters as a size or model.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            Section {
                Text(
                    "Database name search suggests these products. Size and color below come from Product titles, not photo analysis. Check the label before choosing."
                )
                .font(.subheadline).foregroundStyle(.secondary)
            }
            if loading { ProgressView("Finding products…") }
            if let error {
                Section {
                    Text(error).foregroundStyle(PorcelainTokens.destructive)
                    Button("Retry") { Task { await load() } }
                }
            }
            Section("Possible matches") {
                ForEach(candidates, id: \.id) { candidate in
                    HStack(alignment: .top) {
                        Thumb(url: candidate.coverUrl.flatMap(URL.init(string:)), size: 56)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(candidate.name).font(.headline)
                            variantFacts(candidate)
                            Text(reasons(candidate)).font(.caption).foregroundStyle(.secondary)
                            Button("Use this product") {
                                previewCandidate = candidate
                            }
                            .disabled(choosing)
                        }
                    }
                    .padding(.vertical, PorcelainTokens.Space.xs)
                }
                if !loading && candidates.isEmpty && error == nil {
                    Text("No likely existing products found.").foregroundStyle(.secondary)
                }
            }
            Section {
                Button("Search all products", systemImage: "magnifyingglass") {
                    searchingAll = true
                }
                .disabled(choosing)
            }
        }
        .navigationTitle("Possible matches")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .task(id: group.groupKey) { await load() }
        .sheet(isPresented: $searchingAll) {
            EntityPickerSheet(target: .product) { picks in
                guard let product = picks.first else { return }
                Task { await choose(productID: ProductCode(product.id)) }
            }
        }
        .sheet(
            isPresented: Binding(
                get: { previewCandidate != nil },
                set: { if !$0 { previewCandidate = nil } })
        ) {
            if let candidate = previewCandidate {
                NavigationStack {
                    List {
                        Section("What this choice keeps") {
                            LabeledContent("Product name", value: candidate.name)
                            LabeledContent("Product details", value: "Existing values stay")
                            LabeledContent("Existing photos", value: "Keep all")
                        }
                        Section("What this choice adds") {
                            LabeledContent(
                                "Your photos", value: "\(group.images.count) attached after approval")
                            LabeledContent("Photo proposal", value: proposalName)
                            Text(
                                "The proposed name and details will not replace the existing Product. Check size and color before continuing."
                            )
                            .font(.footnote).foregroundStyle(.secondary)
                        }
                        Section("Variant check") {
                            variantFacts(candidate)
                        }
                    }
                    .navigationTitle("Use existing product")
                    #if os(iOS)
                        .navigationBarTitleDisplayMode(.inline)
                    #endif
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { previewCandidate = nil }
                        }
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Use product") {
                                Task { await choose(productID: candidate.id) }
                            }
                            .disabled(choosing)
                        }
                    }
                }
            }
        }
    }

    private var proposalName: String {
        switch group.product {
        case .create(let proposal): proposal.create.name
        case .existing: "Existing Product"
        }
    }

    private func variantFacts(_ candidate: PhotoProductCandidate) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            variantLine(
                "Color", first: candidate.match.variant.color.first,
                second: candidate.match.variant.color.second,
                relation: candidate.match.variant.color.relation.rawValue)
            variantLine(
                "Size", first: candidate.match.variant.size.first,
                second: candidate.match.variant.size.second,
                relation: candidate.match.variant.size.relation.rawValue)
        }
        .font(.caption)
    }

    private func variantLine(
        _ title: String, first: String?, second: String?, relation: String
    ) -> some View {
        let detail =
            relation == "same"
            ? "\(first ?? "Unknown") in both titles"
            : "Proposal: \(first ?? "unknown") · Product: \(second ?? "unknown")"
        return HStack(alignment: .firstTextBaseline) {
            Text("\(title): \(detail)")
                .foregroundStyle(relation == "different" ? PorcelainTokens.warning : .secondary)
            if relation == "different" {
                Image(systemName: "exclamationmark.triangle")
                    .foregroundStyle(PorcelainTokens.warning)
            }
        }
    }

    private func reasons(_ candidate: PhotoProductCandidate) -> String {
        var values = ["Database search"]
        if candidate.match.brandMatches { values.append("same brand") }
        if !candidate.match.sharedNameTerms.isEmpty {
            values.append("shared: \(candidate.match.sharedNameTerms.joined(separator: ", "))")
        }
        if candidate.hasPurchase { values.append("purchase linked") }
        if candidate.hasInventory { values.append("in inventory") }
        values.append(candidate.hasOwnPhoto ? "own photo" : "no own photo")
        values.append(candidate.hasPhotoImport ? "previous photo import" : "no previous photo import")
        return values.joined(separator: " · ")
    }

    private func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            candidates = try await appModel.client.photoProductCandidates(
                runID: runID, groupKey: group.groupKey
            ).candidates
        } catch {
            Diagnostics.report(error, context: "Find photo product matches")
            self.error = error.localizedDescription
        }
    }

    private func choose(productID: ProductCode) async {
        choosing = true
        defer { choosing = false }
        do {
            _ = try await appModel.client.choosePhotoGroupProduct(
                runID: runID, groupKey: group.groupKey, productID: productID)
            onChosen()
            dismiss()
        } catch {
            Diagnostics.report(error, context: "Choose existing product for photo group")
            self.error = error.localizedDescription
        }
    }
}

private struct PhotoGroupDraftEditView: View {
    let runID: String
    let group: PhotoGroupProposal
    let onSaved: () -> Void

    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var manufacturer = ""
    @State private var modelName = ""
    @State private var notes = ""
    @State private var categoryID: String?
    @State private var categoryName: String?
    @State private var choosingCategory = false
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        Form {
            Section("Product") {
                VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
                    Text("Name").font(.caption).foregroundStyle(.secondary)
                    TextField("Product name", text: $name)
                }
                VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
                    Text("Manufacturer").font(.caption).foregroundStyle(.secondary)
                    TextField("Manufacturer", text: $manufacturer)
                }
                VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
                    Text("Model").font(.caption).foregroundStyle(.secondary)
                    TextField("Model", text: $modelName)
                }
                Button {
                    choosingCategory = true
                } label: {
                    LabeledContent("Category", value: categoryName ?? categoryID ?? "Choose category")
                }
                if categoryID != nil {
                    Button("Clear category") {
                        categoryID = nil
                        categoryName = nil
                    }
                }
            }
            Section("Product notes") {
                TextField("Product details", text: $notes, axis: .vertical)
                    .lineLimit(2...5)
            }
            if let error {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(PorcelainTokens.destructive)
                }
            }
        }
        .navigationTitle("Edit product proposal")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { Task { await save() } }
                    .disabled(saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .task(id: group.groupKey) {
            guard case .create(let product) = group.product else { return }
            name = product.create.name
            manufacturer = product.create.manufacturer ?? ""
            modelName = product.create.model ?? ""
            notes = product.create.notes ?? ""
            categoryID = product.create.categoryId
        }
        .sheet(isPresented: $choosingCategory) {
            EntityPickerSheet(
                target: .productCategory, selected: [categoryID].compactMap { $0 }
            ) { picks in
                guard let category = picks.first else { return }
                categoryID = category.id
                categoryName = category.title
            }
        }
    }

    private func save() async {
        guard !saving else { return }
        saving = true
        error = nil
        defer { saving = false }
        do {
            _ = try await appModel.client.updatePhotoGroupDraft(
                .init(
                    runId: runID,
                    groupKey: group.groupKey,
                    name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                    categoryId: categoryID,
                    manufacturer: manufacturer.isEmpty ? nil : manufacturer,
                    model: modelName.isEmpty ? nil : modelName,
                    notes: notes.isEmpty ? nil : notes))
            onSaved()
            dismiss()
        } catch {
            Diagnostics.report(error, context: "Edit photo group product proposal")
            self.error = error.localizedDescription
        }
    }
}

// Reusable by Xcode Preview and the simulator's synthetic review launch mode.
#if DEBUG
    enum ImportRunReviewPreviewFixture {
        static let runID = "RUN-4K7M"

        @MainActor static func model() -> ImportRunReviewModel {
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
                    localAnalysisReady: true, description: "Navy short-sleeve pocket shirt"),
                .init(
                    id: labelID, position: 1, targetState: .pending,
                    originalUrl: "synthetic://label", cutout: .skipped, describe: .ready,
                    localAnalysisReady: true, cutoutReason: "Label evidence does not need a cutout",
                    description: "Neck label close-up"),
            ]
            let review = PhotoRunReviewResponse(
                review: PhotoGroupProposalList(
                    runId: runID, runStatus: .running, proposals: [group], unassignedImageIds: []),
                images: images)
            let run = RunWorkSnapshotOutput(
                runId: runID, purpose: .photoInventory, status: .running,
                startedAt: .now.addingTimeInterval(-12), endedAt: nil,
                coordinatorModel: "gpt-6-sol", agentModelMs: 4_200,
                ordersSeen: 0, imported: 0, updated: 0, skipped: 0,
                targetsTotal: 2, targetsCompleted: 0,
                progress: [
                    .init(phase: "grouping", detail: "Identified one shirt and its label", createdAt: .now)
                ],
                operations: [])
            return ImportRunReviewModel(snapshot: run, review: review)
        }
    }
#endif

#Preview("Photo review", traits: .modifier(SignedInPreview())) {
    NavigationStack {
        ImportRunReviewView(
            runID: ImportRunReviewPreviewFixture.runID,
            previewModel: ImportRunReviewPreviewFixture.model())
    }
}

#Preview("Photo review — intermediate", traits: .modifier(SignedInPreview())) {
    NavigationStack {
        ImportRunReviewView(
            runID: ImportRunReviewPreviewFixture.runID,
            previewModel: ImportRunReviewPreviewFixture.model())
    }
    .frame(width: 760, height: 900)
}

#Preview("Photo review — wide", traits: .modifier(SignedInPreview())) {
    NavigationStack {
        ImportRunReviewView(
            runID: ImportRunReviewPreviewFixture.runID,
            previewModel: ImportRunReviewPreviewFixture.model())
    }
    .frame(width: 1360, height: 900)
}
