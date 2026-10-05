import CubbyKit
import SwiftUI

/// A photo-inventory Run's review: photo processing, the proposed groups with their product
/// decision and photo evidence, and the settled items. List content, so a Run screen places it
/// among its own sections; the screen also applies `photoReviewConfirmations` for the same
/// workspace. No product is created until the household confirms a proposed group.
struct RunPhotoReviewSections: View {
    let runID: String
    let session: RunReviewSession
    let workspace: PhotoReviewWorkspace

    @Environment(AppModel.self) private var appModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var proposed: [PhotoGroupProposal] { workspace.proposed(session) }

    var body: some View {
        if let review = session.review {
            Section {
                photoProcessing(review.images)
                if proposed.isEmpty, review.review.proposals.isEmpty {
                    let readiness = PhotoReviewPolicy.groupingReadiness(
                        images: review.images, runStatus: session.snapshot?.status)
                    Text(readiness.message).foregroundStyle(.secondary)
                    switch readiness {
                    case .needsReviewOnWeb:
                        Link("Group photos on web", destination: appModel.webURL(for: .run, id: runID))
                    case .readyToStart:
                        Button {
                            Task {
                                await session.execute(
                                    .startGrouping, runID: runID, client: appModel.client)
                            }
                        } label: {
                            Label("Start grouping", systemImage: "sparkles")
                        }
                        .disabled(session.busy)
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
                        if !workspace.selectedGroupKeys.isEmpty {
                            Button("Approve selected · \(workspace.approvableSelectedKeys(session).count)") {
                                workspace.freezeApproval(
                                    workspace.approvableSelectedKeys(session), session: session, runID: runID)
                                workspace.confirmingSelected = true
                            }
                            .disabled(session.busy || workspace.approvableSelectedKeys(session).isEmpty)
                        }
                        Button("Approve all") {
                            workspace.freezeApproval(
                                proposed.map(\.groupKey), session: session, runID: runID)
                            workspace.confirmingAll = true
                        }
                        .disabled(
                            session.busy
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

    private func refresh() async {
        await session.refresh(runID: runID, client: appModel.client)
    }

    private func reviewWorkspace(_ review: PhotoRunReviewResponse) -> some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                stackedReviewWorkspace(review.images)
                    .frame(maxWidth: 720, alignment: .leading)
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: FieldGuideTokens.Space.lg) {
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
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.lg) {
            groupRegion
            decisionRegion(images)
            evidenceRegion(images)
        }
    }

    private var selectedProposal: PhotoGroupProposal? {
        proposed.first { $0.groupKey == workspace.selectedGroupKey } ?? proposed.first
    }

    private var groupRegion: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            Text("Groups").font(.headline)
            ForEach(proposed, id: \.groupKey) { group in
                Button {
                    workspace.selectedGroupKey = group.groupKey
                } label: {
                    HStack {
                        Text(groupName(group)).lineLimit(2)
                        Spacer(minLength: 4)
                        if selectedProposal?.groupKey == group.groupKey {
                            Image(systemName: "checkmark").accessibilityHidden(true)
                        }
                    }
                    .frame(minHeight: FieldGuideTokens.touchTarget, alignment: .leading)
                    // A plain button only takes taps on drawn content; without this the space
                    // after the name ignored taps, so the open group did not change.
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selectedProposal?.groupKey == group.groupKey ? .isSelected : [])
            }
        }
        .accessibilityIdentifier("review.groups")
    }

    @ViewBuilder private func decisionRegion(_ images: [PhotoRunImage]) -> some View {
        if let group = selectedProposal {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                Text("Product decision").font(.headline)
                proposal(group, images: images)
            }
            .accessibilityIdentifier("review.decision")
        }
    }

    private func evidenceRegion(_ images: [PhotoRunImage]) -> some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            Text("Photo evidence · \(images.count)").font(.headline)
            ForEach(images, id: \.id) { image in
                HStack(alignment: .top, spacing: FieldGuideTokens.Space.sm) {
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
                        // The server parks a cutout as waiting-for-device until the description
                        // decides whether the photo is worth cutting out.
                        if image.cutout == .waitingForDevice, image.describe != .ready {
                            Label("Cutout: Waiting for description", systemImage: "clock")
                                .foregroundStyle(.secondary)
                        } else {
                            processingLabel("Cutout", state: image.cutout, reason: image.cutoutReason)
                        }
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
        return VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: FieldGuideTokens.Space.xl) {
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
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            Text(title).font(.caption2).foregroundStyle(.secondary)
            Text("\(done)/\(total)").font(.subheadline.weight(.semibold)).monospacedDigit()
        }
    }

    private func proposal(_ group: PhotoGroupProposal, images: [PhotoRunImage]) -> some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            HStack {
                Text(groupName(group)).font(.headline)
                Spacer()
                Button {
                    if workspace.selectedGroupKeys.contains(group.groupKey) {
                        workspace.selectedGroupKeys.remove(group.groupKey)
                    } else {
                        workspace.selectedGroupKeys.insert(group.groupKey)
                    }
                } label: {
                    Label(
                        workspace.selectedGroupKeys.contains(group.groupKey) ? "Selected" : "Select",
                        systemImage: workspace.selectedGroupKeys.contains(group.groupKey)
                            ? "checkmark.circle.fill" : "circle"
                    )
                    .touchTargetLabel()
                }
                .disabled(session.busy || approvalBlocker(group, images: images) != nil)
            }
            ScrollView(.horizontal) {
                HStack(spacing: FieldGuideTokens.Space.sm) {
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
                .foregroundStyle(FieldGuideTokens.warning)
            }
            if let blocker = approvalBlocker(group, images: images) {
                Text(blocker).font(.caption).foregroundStyle(FieldGuideTokens.warning)
            }
            if let error = group.lastError {
                Text(error).foregroundStyle(FieldGuideTokens.destructive)
            }
            NavigationLink {
                PhotoCandidateSelectionView(runID: runID, group: group, images: images) {
                    Task { await refresh() }
                }
            } label: {
                Label("Compare possible matches", systemImage: "square.stack.3d.up")
                    .touchTargetLabel()
            }
            if case .create = group.product {
                NavigationLink {
                    PhotoGroupDraftEditView(runID: runID, group: group) {
                        Task { await refresh() }
                    }
                } label: {
                    Label("Edit proposed product", systemImage: "pencil")
                        .touchTargetLabel()
                }
            }
            HStack {
                Button("Approve") {
                    workspace.freezeApproval([group.groupKey], session: session, runID: runID)
                    workspace.confirmingGroup = group.groupKey
                }
                .buttonStyle(.borderedProminent)
                .disabled(session.busy || approvalBlocker(group, images: images) != nil)
                Button(role: .destructive) {
                    workspace.discardingGroup = group.groupKey
                } label: {
                    Text("Discard").touchTargetLabel()
                }
                .disabled(session.busy)
            }
        }
        .padding(.vertical, FieldGuideTokens.Space.xs)
        // The whole workspace is one List row. A row's automatic-style buttons and links all fire
        // on any tap in it, so Select also pushed both match and draft screens; an explicit
        // style keeps each control to its own hit area, which `touchTargetLabel` sizes.
        .buttonStyle(.borderless)
    }

    private func groupName(_ group: PhotoGroupProposal) -> String {
        switch group.product {
        case .create(let product): product.create.name
        case .existing(let product): product.existing?.name ?? "Existing product"
        }
    }

    private func approvalBlocker(_ group: PhotoGroupProposal, images: [PhotoRunImage]) -> String? {
        PhotoReviewPolicy.approvalBlocker(
            group: group, images: images, runStatus: session.review?.review.runStatus)
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
                .foregroundStyle(state == .ready ? FieldGuideTokens.positive : .secondary)
            if let reason, !reason.isEmpty { Text(reason).foregroundStyle(.secondary) }
        }
    }
}

extension View {
    /// A borderless control's hit area is its label's shape, so the minimum height and the
    /// rectangle go inside the label; a frame outside it grows the layout but not the hit area.
    fileprivate func touchTargetLabel() -> some View {
        frame(minHeight: FieldGuideTokens.touchTarget, alignment: .leading)
            .contentShape(.rect)
    }
}

#if DEBUG
    #Preview("Photo review sections", traits: .modifier(SignedInPreview())) {
        @Previewable @State var session = RunReviewPreviewFixture.model()
        @Previewable @State var workspace = PhotoReviewWorkspace()
        NavigationStack {
            List {
                RunPhotoReviewSections(
                    runID: RunReviewPreviewFixture.runID, session: session, workspace: workspace)
            }
            .photoReviewConfirmations(workspace, session: session, runID: RunReviewPreviewFixture.runID)
        }
    }
#endif
