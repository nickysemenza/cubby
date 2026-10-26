import Foundation
import Observation

private struct RunMismatch: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/// A Run console's own reads: the Run's work snapshot and, for a photo Run, its photo processing
/// and lifecycle. Photo-group decisions are web's (`run/<id>#photo-batch`); the only command here
/// starts grouping once every photo's description has settled.
@MainActor @Observable
public final class RunConsoleSession {
    public private(set) var snapshot: RunSnapshot?
    public private(set) var review: PhotoRunReviewResponse?
    public private(set) var error: String?
    public private(set) var actionError: String?
    public private(set) var busy = false
    /// Successful commands invalidate reports even when a stopped Run has no active poll.
    public private(set) var actionRevision = 0
    public private(set) var autoStartAttempted = false
    @ObservationIgnored private var refreshGeneration = 0
    @ObservationIgnored private let reportDiagnostic: @MainActor (any Error, String) -> Void

    public init(
        snapshot: RunSnapshot? = nil, review: PhotoRunReviewResponse? = nil,
        reportDiagnostic: @escaping @MainActor (any Error, String) -> Void = { _, _ in }
    ) {
        self.snapshot = snapshot
        self.review = review
        self.reportDiagnostic = reportDiagnostic
    }

    public var groupingReadiness: PhotoGroupingReadiness? {
        review.map { PhotoGroupingReadiness(images: $0.images, runStatus: snapshot?.status) }
    }

    public func refresh(runID: String, client: CubbyClient) async {
        await refresh(
            runID: runID,
            loadSnapshot: { try await client.runSnapshot(runID: runID) },
            loadReview: { try await client.photoRunReview(.init(runId: runID)) })
    }

    func refresh(
        runID: String, loadSnapshot: @MainActor () async throws -> RunSnapshot,
        loadReview: @MainActor () async throws -> PhotoRunReviewResponse?
    ) async {
        refreshGeneration += 1
        let generation = refreshGeneration
        do {
            let next = try await loadSnapshot()
            try Task.checkCancellation()
            guard generation == refreshGeneration else { return }
            guard next.runID == runID else { throw RunMismatch("The snapshot belongs to another Run.") }
            let nextReview = next.purpose == .photoInventory ? try await loadReview() : nil
            try Task.checkCancellation()
            guard generation == refreshGeneration else { return }
            if let nextReview, nextReview.review.runId != runID {
                throw RunMismatch("The photo review belongs to another Run.")
            }
            snapshot = next
            review = nextReview
            error = nil
        } catch is CancellationError {
            // Dismissal and newer refreshes retain the Run already visible.
        } catch {
            guard generation == refreshGeneration else { return }
            reportDiagnostic(error, "Load import run")
            self.error = error.userMessage
        }
    }

    /// Asks the agent to propose item groups; the server revalidates that descriptions settled.
    @discardableResult
    public func startGrouping(runID: String, client: CubbyClient) async -> Bool {
        guard !busy else { return false }
        busy = true
        actionError = nil
        defer { busy = false }
        do {
            _ = try await client.startPhotoGrouping(.init(runId: runID))
            await refresh(runID: runID, client: client)
            actionRevision += 1
            return true
        } catch {
            reportDiagnostic(error, "Start photo grouping")
            actionError = error.userMessage
            return false
        }
    }

    /// Starts grouping once, when every photo's description has settled; the server applies the
    /// same gate (`startPhotoGroupingForActor`), since a coordinator started earlier sees bare
    /// photos and stops for review.
    public func autoStartGroupingWhenAnalyzed(runID: String, client: CubbyClient) async {
        guard !autoStartAttempted, review?.review.proposals.isEmpty == true,
            groupingReadiness == .readyToStart
        else { return }
        autoStartAttempted = true
        await startGrouping(runID: runID, client: client)
    }
}
