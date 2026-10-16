import CubbyKit
import SwiftUI

/// Selection and discard confirmation for one photo-inventory Run. Approval captures the
/// current reviewed revisions at the moment the member presses Create or Attach.
@MainActor @Observable
final class PhotoReviewWorkspace {
    var discardingGroup: String?
    var selectedGroupKeys: Set<String> = []
    var selectedGroupKey: String?
    private(set) var autoStartAttempted = false

    func proposed(_ session: RunReviewSession) -> [PhotoGroupProposal] {
        session.review?.review.proposals.filter { $0.state == .proposed } ?? []
    }

    func approvableSelectedKeys(_ session: RunReviewSession) -> [String] {
        PhotoReviewPolicy.approvableSelection(
            selected: selectedGroupKeys, groups: proposed(session))
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

    func approve(_ keys: [String], session: RunReviewSession, runID: String, client: CubbyClient) {
        guard !keys.isEmpty else { return }
        let reviewed = session.document(runID: runID)
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
                images: review.images, runStatus: session.snapshot?.status,
                processingPaused: review.imageProcessingPaused) == .readyToStart
        else { return }
        autoStartAttempted = true
        await session.execute(.startGrouping, runID: runID, client: client)
    }
}

extension View {
    /// The discard confirmation attaches to the screen so it presents once for the workspace.
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
        content.confirmationDialog(
            "Discard this item?",
            isPresented: Binding(
                get: { workspace.discardingGroup != nil },
                set: { if !$0 { workspace.discardingGroup = nil } })
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
}
