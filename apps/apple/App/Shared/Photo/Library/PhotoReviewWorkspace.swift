import CubbyKit
import SwiftUI

/// The photo-review state of one photo-inventory Run: which group is open, which groups are
/// selected, and the approval frozen for confirmation. The approval keys and the reviewed
/// document are captured together when a confirmation opens, so a refresh that lands while the
/// dialog is up never changes what is approved.
@MainActor @Observable
final class PhotoReviewWorkspace {
    var confirmingGroup: String?
    var confirmingAll = false
    var confirmingSelected = false
    var discardingGroup: String?
    var selectedGroupKeys: Set<String> = []
    var selectedGroupKey: String?
    private(set) var approvalKeys: [String] = []
    private(set) var autoStartAttempted = false
    private var approvalReview: RunReviewDocument?

    func proposed(_ session: RunReviewSession) -> [PhotoGroupProposal] {
        session.review?.review.proposals.filter { $0.state == .proposed } ?? []
    }

    func approvableSelectedKeys(_ session: RunReviewSession) -> [String] {
        PhotoReviewPolicy.approvableSelection(
            selected: selectedGroupKeys, groups: proposed(session),
            images: session.review?.images ?? [], runStatus: session.snapshot?.status)
    }

    func stage(_ session: RunReviewSession) -> String {
        guard let review = session.review else { return "Loading photos" }
        let proposed = proposed(session)
        if session.snapshot?.status == .completed { return "Review complete" }
        if !proposed.isEmpty {
            return "\(proposed.count) item \(proposed.count == 1 ? "group" : "groups") ready for review"
        }
        if review.images.isEmpty { return "Waiting for photos to upload" }
        if session.snapshot?.status == .needsReview { return "Agent stopped; photos need review" }
        if session.actionError != nil { return "Grouping needs attention" }
        if !autoStartAttempted { return "Photos uploaded; ready to group" }
        return "Agent is preparing item groups"
    }

    func freezeApproval(_ keys: [String], session: RunReviewSession, runID: String) {
        approvalKeys = keys
        approvalReview = session.document(runID: runID)
    }

    func approve(session: RunReviewSession, runID: String, client: CubbyClient) {
        guard let reviewed = approvalReview, !approvalKeys.isEmpty else { return }
        let keys = approvalKeys
        approvalReview = nil
        approvalKeys = []
        Task {
            let approved = await session.execute(
                .approvePhotoGroups(reviewed: reviewed, groupKeys: keys),
                runID: runID, client: client)
            if approved { selectedGroupKeys.subtract(keys) }
        }
    }

    /// Starts grouping once every photo's description has settled; the server applies the
    /// same gate (`startPhotoGroupingForActor`), since a coordinator started earlier sees bare
    /// photos and stops for review.
    func autoStartGroupingWhenAnalyzed(
        session: RunReviewSession, runID: String, client: CubbyClient
    ) async {
        guard !autoStartAttempted,
            let review = session.review,
            review.review.proposals.isEmpty,
            PhotoReviewPolicy.groupingReadiness(
                images: review.images, runStatus: session.snapshot?.status) == .readyToStart
        else { return }
        autoStartAttempted = true
        await session.execute(.startGrouping, runID: runID, client: client)
    }
}

extension View {
    /// The approve and discard confirmations of a photo review. They attach to the screen's
    /// list rather than to a row, so each presents once for the whole review.
    func photoReviewConfirmations(
        _ workspace: PhotoReviewWorkspace, session: RunReviewSession, runID: String
    ) -> some View {
        modifier(PhotoReviewConfirmations(workspace: workspace, session: session, runID: runID))
    }
}

private struct PhotoReviewConfirmations: ViewModifier {
    @Bindable var workspace: PhotoReviewWorkspace
    let session: RunReviewSession
    let runID: String

    @Environment(AppModel.self) private var appModel

    func body(content: Content) -> some View {
        content
            .confirmationDialog(
                "Approve this item?",
                isPresented: Binding(
                    get: { workspace.confirmingGroup != nil },
                    set: { if !$0 { workspace.confirmingGroup = nil } }
                )
            ) {
                if workspace.confirmingGroup != nil {
                    Button("Create or link product") { approve() }
                }
            } message: {
                Text("This attaches the photos and commits the proposed product choice.")
            }
            .confirmationDialog("Approve all proposed items?", isPresented: $workspace.confirmingAll) {
                Button("Approve \(workspace.approvalKeys.count) items") { approve() }
            }
            .confirmationDialog(
                "Approve selected items?", isPresented: $workspace.confirmingSelected
            ) {
                Button("Approve \(workspace.approvalKeys.count) items") { approve() }
            } message: {
                Text("Products are created or linked only for the selected, ready items.")
            }
            .confirmationDialog(
                "Discard this item?",
                isPresented: Binding(
                    get: { workspace.discardingGroup != nil },
                    set: { if !$0 { workspace.discardingGroup = nil } }
                )
            ) {
                if let group = workspace.discardingGroup {
                    Button("Discard proposal", role: .destructive) {
                        Task {
                            await session.execute(
                                .discardPhotoGroup(groupKey: group), runID: runID,
                                client: appModel.client)
                        }
                    }
                }
            }
    }

    private func approve() {
        workspace.approve(session: session, runID: runID, client: appModel.client)
    }
}
