import Foundation

/// Whether the "Start grouping" action belongs on screen, and what to say instead when it
/// doesn't. Zero photos and mid-processing both hide the action — grouping needs settled
/// descriptions to work from, not just an upload.
public enum PhotoGroupingReadiness: Equatable, Sendable {
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

    public var message: String {
        switch self {
        case .waitingForPhotos: "Waiting for photos to upload."
        case .processing: "Photos are processing. Grouping starts once descriptions are ready."
        case .readyToStart: "Photos are ready for the agent to propose item groups."
        case .needsReviewOnWeb: "The agent stopped before proposing groups. Review these photos on the web."
        case .working: "Photos uploaded; the agent is preparing item groups."
        }
    }
}

public enum PhotoReviewPolicy {
    public static func approvableSelection(
        selected: Set<String>, groups: [PhotoGroupProposal], images: [PhotoRunImage],
        runStatus: RunStatus?
    ) -> [String] {
        groups.filter {
            selected.contains($0.groupKey) && $0.state == .proposed
                && approvalBlocker(group: $0, images: images, runStatus: runStatus) == nil
        }.map(\.groupKey)
    }

    /// A photo counts as settled for grouping once its description job reaches a terminal state
    /// (ready, skipped, or failed) — `.pending`/`.leased`/`.waitingForDevice` mean grouping would
    /// start from incomplete evidence.
    public static func groupingReadiness(
        images: [PhotoRunImage], runStatus: RunStatus?
    ) -> PhotoGroupingReadiness {
        guard !images.isEmpty else { return .waitingForPhotos }
        if runStatus == .needsReview { return .needsReviewOnWeb }
        let settled = images.allSatisfy {
            $0.describe == .ready || $0.describe == .skipped || $0.describe == .failed
        }
        guard settled else { return .processing }
        return runStatus == .running ? .readyToStart : .working
    }

    public static func approvalBlocker(
        group: PhotoGroupProposal, images: [PhotoRunImage], runStatus: RunStatus?
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
