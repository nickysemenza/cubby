import Foundation
import Observation

/// A frozen review, including proposal revisions and the backend's finding fingerprint.
public struct RunReviewDocument: Codable, Sendable {
    public let runID: String
    public let snapshot: RunWorkSnapshotOutput?
    public let review: PhotoRunReviewResponse?

    public init(
        runID: String, snapshot: RunWorkSnapshotOutput?, review: PhotoRunReviewResponse?
    ) {
        self.runID = runID
        self.snapshot = snapshot
        self.review = review
    }
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
    public private(set) var snapshot: RunWorkSnapshotOutput?
    public private(set) var review: PhotoRunReviewResponse?
    public private(set) var error: String?
    public private(set) var actionError: String?
    public private(set) var busy = false

    @ObservationIgnored private let reportDiagnostic: @MainActor (any Error, String) -> Void

    public init(
        snapshot: RunWorkSnapshotOutput? = nil, review: PhotoRunReviewResponse? = nil,
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
        do {
            let next = try await client.runWorkSnapshot(.init(runId: runID))
            snapshot = next
            error = nil
            if next.purpose == .photoInventory {
                review = try await client.photoRunReview(.init(runId: runID))
            }
        } catch {
            reportDiagnostic(error, "Load import run review")
            self.error = error.localizedDescription
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
                try requireMatchingRun(reviewed, runID: runID)
                guard let photoReview = reviewed.review, !groupKeys.isEmpty,
                    Set(groupKeys).count == groupKeys.count
                else { throw ReviewRequired("Select the exact photo groups you reviewed.") }
                let groups = try groupKeys.map { key in
                    guard let group = photoReview.review.proposals.first(where: { $0.groupKey == key }),
                        group.state == .proposed
                    else { throw ReviewRequired("The selected group is absent from the reviewed proposals.") }
                    if let blocker = PhotoReviewPolicy.approvalBlocker(
                        group: group, images: photoReview.images, runStatus: photoReview.review.runStatus)
                    {
                        throw ReviewRequired(blocker)
                    }
                    return group
                }
                _ = try await client.approvePhotoGroups(runID: runID, groups: groups)
            case .resolveFinding(let reviewed, let id, let apply, let fingerprint):
                try requireMatchingRun(reviewed, runID: runID)
                let findings = try reviewed.snapshot.map { try JSONValue(encoding: $0.findings) }
                guard let finding = findings?.arrayValue?.first(where: { $0["id"]?.stringValue == id })
                else { throw ReviewRequired("The finding is absent from the reviewed run.") }
                if apply {
                    let shown = finding["proposedFix"]?["reviewSnapshot"]?["fingerprint"]?.stringValue
                    guard let fingerprint, !fingerprint.isEmpty, fingerprint == shown else {
                        throw ReviewRequired("Confirm the exact finding fingerprint shown in the review.")
                    }
                }
                _ = try await client.resolveRunFinding(
                    .init(reviewedFingerprint: fingerprint, id: id, action: apply ? .apply : .dismiss))
            }
            await refresh(runID: runID, client: client)
            return true
        } catch {
            reportDiagnostic(error, "Update import run")
            actionError = error.localizedDescription
            return false
        }
    }

    private func requireMatchingRun(_ reviewed: RunReviewDocument, runID: String) throws {
        guard reviewed.runID == runID, reviewed.snapshot?.runId == runID else {
            throw ReviewRequired("Review this run before submitting its proposals or findings.")
        }
    }

    private struct ReviewRequired: LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }
}
