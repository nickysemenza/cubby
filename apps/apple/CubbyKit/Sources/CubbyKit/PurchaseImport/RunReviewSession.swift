import Foundation
import Observation

/// A frozen review, including proposal revisions and the backend's finding fingerprint.
public struct RunReviewDocument: Codable, Sendable {
    public let runID: String
    public let snapshot: RunSnapshot?
    public let review: PhotoRunReviewResponse?

    public init(
        runID: String, snapshot: RunSnapshot?, review: PhotoRunReviewResponse?
    ) {
        self.runID = runID
        self.snapshot = snapshot
        self.review = review
    }

    func photoGroups(runID: String, keys: [String]) throws -> [PhotoGroupProposal] {
        try requireMatchingRun(runID)
        guard let review, review.review.runId == runID, !keys.isEmpty,
            Set(keys).count == keys.count
        else { throw ReviewRequired("Select the exact photo groups you reviewed.") }
        return try keys.map { key in
            guard let group = review.review.proposals.first(where: { $0.groupKey == key }),
                group.state == .proposed
            else { throw ReviewRequired("The selected group is absent from the reviewed proposals.") }
            if let blocker = group.blockedReason { throw ReviewRequired(blocker) }
            return group
        }
    }

    func findingInput(runID: String, id: String, apply: Bool, reviewedFingerprint: String?) throws
        -> ResolveRunFindingInput
    {
        try requireMatchingRun(runID)
        guard let finding = snapshot?.finding(id: id) else {
            throw ReviewRequired("The finding is absent from the reviewed run.")
        }
        if apply {
            let shown = finding["proposedFix"]?["reviewSnapshot"]?["fingerprint"]?.stringValue
            guard let reviewedFingerprint, !reviewedFingerprint.isEmpty, reviewedFingerprint == shown else {
                throw ReviewRequired("Confirm the exact finding fingerprint shown in the review.")
            }
        }
        return .init(reviewedFingerprint: reviewedFingerprint, id: id, action: apply ? .apply : .dismiss)
    }

    private func requireMatchingRun(_ runID: String) throws {
        guard self.runID == runID, snapshot?.runID == runID else {
            throw ReviewRequired("Review this run before submitting its proposals or findings.")
        }
    }
}

private struct ReviewRequired: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/// Mutating commands are explicit; refreshing a review never approves its proposals.
public enum RunReviewAction: Sendable {
    case startGrouping
    case discardPhotoGroup(groupKey: String)
    case approvePhotoGroups(reviewed: RunReviewDocument, groupKeys: [String])
    case resolveFinding(
        reviewed: RunReviewDocument, id: String, apply: Bool, reviewedFingerprint: String?)
}

@MainActor @Observable
public final class RunReviewSession {
    public private(set) var snapshot: RunSnapshot?
    public private(set) var review: PhotoRunReviewResponse?
    public private(set) var error: String?
    public private(set) var actionError: String?
    public private(set) var busy = false
    /// Successful commands invalidate reports even when a stopped Run has no active poll.
    public private(set) var actionRevision = 0
    public private(set) var candidateGroups: [String: PhotoCandidateGroupResult] = [:]
    public private(set) var candidatesError: String?
    public private(set) var checkingCandidates = false
    @ObservationIgnored private var refreshGeneration = 0
    @ObservationIgnored private var candidateKey: String?
    @ObservationIgnored private var activeCandidateKey: String?
    @ObservationIgnored private var candidateTask: Task<Void, Never>?
    @ObservationIgnored private var pendingCandidates:
        (
            key: String, load: @MainActor () async throws -> [String: PhotoCandidateGroupResult]
        )?

    public func candidateRevision(runID: String) -> String {
        let revisions = (review?.review.proposals ?? []).sorted { $0.groupKey < $1.groupKey }
            .map { "\($0.groupKey.utf8.count):\($0.groupKey):\($0.updatedAt)" }
        return "\(runID.utf8.count):\(runID)|\(revisions.joined(separator: "|"))"
    }

    public func loadCandidates(runID: String, client: CubbyClient, force: Bool = false) async {
        let task = refreshCandidates(key: candidateRevision(runID: runID), force: force) {
            try await client.photoCandidateGroups(runID: runID)
        }
        await task?.value
    }

    /// Own the request independently of SwiftUI task cancellation. Revision changes during a
    /// request replace a single queued refresh; superseded responses never become visible.
    func refreshCandidates(
        key: String, force: Bool = false,
        load: @escaping @MainActor () async throws -> [String: PhotoCandidateGroupResult]
    ) -> Task<Void, Never>? {
        if !force {
            if pendingCandidates?.key == key || (pendingCandidates == nil && activeCandidateKey == key) {
                return candidateTask
            }
            if candidateTask == nil && candidateKey == key { return nil }
        }
        pendingCandidates = (key, load)
        if let candidateTask { return candidateTask }
        checkingCandidates = true
        let task = Task {
            defer {
                checkingCandidates = false
                candidateTask = nil
                activeCandidateKey = nil
            }
            while let request = pendingCandidates {
                pendingCandidates = nil
                activeCandidateKey = request.key
                do {
                    let groups = try await request.load()
                    guard pendingCandidates == nil else { continue }
                    candidateGroups = groups
                    candidateKey = request.key
                    candidatesError = nil
                } catch {
                    guard pendingCandidates == nil else { continue }
                    reportDiagnostic(error, "Check photo candidates")
                    candidatesError = error.userMessage
                }
            }
        }
        candidateTask = task
        return task
    }

    @ObservationIgnored private let reportDiagnostic: @MainActor (any Error, String) -> Void

    public init(
        snapshot: RunSnapshot? = nil, review: PhotoRunReviewResponse? = nil,
        reportDiagnostic: @escaping @MainActor (any Error, String) -> Void = { _, _ in }
    ) {
        self.snapshot = snapshot
        self.review = review
        self.reportDiagnostic = reportDiagnostic
    }

    public func document(runID: String) -> RunReviewDocument {
        RunReviewDocument(runID: runID, snapshot: snapshot, review: review)
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
            guard next.runID == runID else { throw ReviewRequired("The snapshot belongs to another Run.") }
            let nextReview = next.purpose == .photoInventory ? try await loadReview() : nil
            try Task.checkCancellation()
            guard generation == refreshGeneration else { return }
            if let nextReview, nextReview.review.runId != runID {
                throw ReviewRequired("The photo review belongs to another Run.")
            }
            snapshot = next
            review = nextReview
            error = nil
        } catch is CancellationError {
            // Dismissal and newer refreshes retain the review already visible.
        } catch {
            guard generation == refreshGeneration else { return }
            reportDiagnostic(error, "Load import run review")
            self.error = error.userMessage
        }
    }

    /// Uses exactly the reviewed revisions/fingerprint; the backend revalidates current state.
    @discardableResult
    public func execute(
        _ action: RunReviewAction, runID: String, client: CubbyClient
    ) async -> Bool {
        guard !busy else { return false }
        busy = true
        actionError = nil
        defer { busy = false }
        do {
            switch action {
            case .startGrouping:
                _ = try await client.startPhotoGrouping(.init(runId: runID))
            case .discardPhotoGroup(let groupKey):
                _ = try await client.discardPhotoGroup(.init(runId: runID, groupKey: groupKey))
            case .approvePhotoGroups(let reviewed, let groupKeys):
                let groups = try reviewed.photoGroups(runID: runID, keys: groupKeys)
                _ = try await client.approvePhotoGroups(runID: runID, groups: groups)
            case .resolveFinding(let reviewed, let id, let apply, let fingerprint):
                _ = try await client.resolveRunFinding(
                    reviewed.findingInput(
                        runID: runID, id: id, apply: apply, reviewedFingerprint: fingerprint))
            }
            await refresh(runID: runID, client: client)
            actionRevision += 1
            return true
        } catch {
            reportDiagnostic(error, "Update import run")
            actionError = error.userMessage
            return false
        }
    }

}
