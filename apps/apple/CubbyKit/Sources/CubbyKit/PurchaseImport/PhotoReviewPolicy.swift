import Foundation

/// Whether the "Start grouping" action belongs on screen, and what to say instead when it
/// doesn't. Zero photos and mid-processing both hide the action — grouping needs settled
/// descriptions to work from, not just an upload.
public enum PhotoGroupingReadiness: Equatable, Sendable {
    /// No photos have arrived yet; nothing to group.
    case waitingForPhotos
    /// Photos arrived but device/description processing hasn't settled for all of them.
    case processing
    /// Descriptions are queued but household image work is paused, so they will not settle until
    /// someone resumes it.
    case processingPaused
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
        case .processingPaused:
            "Image processing is paused, so photo descriptions are queued. Resume queued work under Problems → Image processing on the web to start grouping."
        case .readyToStart: "Photos are ready for the agent to propose item groups."
        case .needsReviewOnWeb: "The agent stopped before proposing groups. Review these photos on the web."
        case .working: "Photos uploaded; the agent is preparing item groups."
        }
    }
}

public enum PhotoReviewPolicy {
    /// Model judgments never establish deterministic correctness.
    public static func crossCheckMark(_ check: PhotoFieldCrossCheck) -> String {
        if check.mark.rawValue == "agree", check.source.rawValue == "deterministic" { return "✓" }
        return check.mark.rawValue == "disagree-or-missing" ? "!" : "?"
    }

    public static func isCreate(group: PhotoGroupProposal) -> Bool {
        if case .create = group.product { return true }
        return false
    }

    public static func primaryVerb(group: PhotoGroupProposal) -> String {
        if group.images.isEmpty, !group.skip.isEmpty { return "Skip \(group.skip.count) photos" }
        return switch group.product {
        case .create: "Create product"
        case .existing: "Attach \(group.images.count) \(group.images.count == 1 ? "photo" : "photos")"
        }
    }

    public static func effects(group: PhotoGroupProposal) -> String {
        if group.images.isEmpty, !group.skip.isEmpty {
            return "Skip \(group.skip.count) photos. No Product or stock change."
        }
        let productEffect: String
        switch group.product {
        case .create(let product):
            productEffect = "Create \(product.create.name) and attach \(group.images.count) photos."
        case .existing(let product):
            productEffect =
                "Attach \(group.images.count) photos to \(product.existing?.name ?? "the selected Product"). Keep gallery order and cover."
        }
        let changesEffect = group.review?.productChanges == nil ? "" : " Apply the reviewed Product edits."
        let stockEffect: String
        if let inventory = group.inventory {
            stockEffect =
                "\(inventory.mode == .add ? "Add" : "Create a count of") \(inventory.quantity) at \(inventory.locationName ?? "the selected location")."
        } else {
            stockEffect = "No stock change. Historical photos do not record a sale."
        }
        return "\(productEffect)\(changesEffect) \(stockEffect) \(group.skip.count) photos skipped."
    }

    public static func approvableSelection(
        selected: Set<String>, groups: [PhotoGroupProposal]
    ) -> [String] {
        groups.filter {
            selected.contains($0.groupKey) && $0.state == .proposed && $0.blockedReason == nil
        }.map(\.groupKey)
    }

    /// A photo counts as settled for grouping once its description job reaches a terminal state
    /// (ready, skipped, or failed) — `.pending`/`.leased`/`.waitingForDevice` mean grouping would
    /// start from incomplete evidence.
    public static func groupingReadiness(
        images: [PhotoRunImage], runStatus: RunStatus?, processingPaused: Bool
    ) -> PhotoGroupingReadiness {
        guard !images.isEmpty else { return .waitingForPhotos }
        if runStatus == .needsReview { return .needsReviewOnWeb }
        let settled = images.allSatisfy {
            $0.describe == .ready || $0.describe == .skipped || $0.describe == .failed
        }
        guard settled else { return processingPaused ? .processingPaused : .processing }
        return runStatus == .running ? .readyToStart : .working
    }

}
