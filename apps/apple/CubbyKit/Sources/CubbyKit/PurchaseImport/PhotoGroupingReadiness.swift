import Foundation

/// Whether the "Start grouping" action belongs on screen, and what to say instead when it
/// doesn't. Zero photos and mid-processing both hide the action — grouping needs settled
/// descriptions to work from, not just an upload.
public enum PhotoGroupingReadiness: Equatable, Sendable {
    /// No photos have arrived yet; nothing to group.
    case waitingForPhotos
    /// Photos arrived but device/description processing hasn't settled for all of them.
    case processing
    /// Every description settled, but these photos have none (failed or skipped): the member
    /// retries them or continues without them (`photoImport.excludeFailed`) before grouping.
    case descriptionsMissing([ImageCode])
    /// Photos are uploaded and described; the agent can be started.
    case readyToStart
    /// The agent already stopped short of proposing groups; review continues on the web.
    case needsReviewOnWeb
    /// The agent is between stages (already asked to start, or run isn't `.running`).
    case working

    /// A photo counts as settled for grouping once its description job reaches a terminal state
    /// (ready, skipped, or failed) — `.pending`/`.leased`/`.waitingForDevice` mean grouping would
    /// start from incomplete evidence. A settled photo still in the import without a description
    /// (failed or skipped) holds grouping until the member retries it or continues without it,
    /// mirroring the server's `DESCRIPTION_MISSING` gate (photo-import `lifecycle.ts`).
    public init(images: [PhotoRunImage], runStatus: RunStatus?) {
        guard !images.isEmpty else {
            self = .waitingForPhotos
            return
        }
        let settled = images.allSatisfy { $0.describe == .ready || Self.descriptionMissing($0) }
        let missing = images.filter { $0.targetState == .pending && Self.descriptionMissing($0) }
        // The server holds the Run for these photos; continuing without them is answerable here.
        if settled, !missing.isEmpty {
            self = .descriptionsMissing(missing.map(\.id))
        } else if runStatus == .needsReview {
            self = .needsReviewOnWeb
        } else if !settled {
            self = .processing
        } else {
            self = runStatus == .running ? .readyToStart : .working
        }
    }

    /// A settled description that left the photo without one; the server lists these photos in
    /// `PhotoRunLifecycle.failedImageIds` and `photoImport.excludeFailed` accepts them.
    public static func descriptionMissing(_ image: PhotoRunImage) -> Bool {
        image.describe == .failed || image.describe == .skipped
    }

    public var message: String {
        switch self {
        case .waitingForPhotos: "Waiting for photos to upload."
        case .processing: "Photos are processing. Grouping starts once descriptions are ready."
        case .descriptionsMissing(let ids):
            ids.count == 1
                ? "1 photo has no description. Retry it or continue without it."
                : "\(ids.count) photos have no description. Retry them or continue without them."
        case .readyToStart: "Photos are ready for the agent to propose item groups."
        case .needsReviewOnWeb: "The agent stopped before proposing groups. Review these photos on the web."
        case .working: "Photos uploaded; the agent is preparing item groups."
        }
    }
}
