import CubbyAPI
import Foundation

extension CubbyClient {
    public func savePhotoGroups(runID: String, groups: [JSONValue]) async throws -> ReviewPhotoGroupsOutput {
        let body: JSONValue = ["runId": .string(runID), "groups": .array(groups)]
        return try await request("photoImport.saveGroups", body: body)
    }

    public func photoCandidateGroups(runID: String) async throws -> [String: PhotoCandidateGroupResult] {
        let response = try await native_photoImport_candidatesBatch(body: .init(runId: runID))
        return Dictionary(uniqueKeysWithValues: response.groups.map { ($0.groupKey, $0) })
    }

    public func photoEvidence(runID: String, productID: ProductCode) async throws -> PhotoProductEvidence {
        return try await native_photoImport_productEvidence(
            body: .init(runId: runID, productId: productID)
        )
    }

    public func rejectPhotoCandidate(runID: String, groupKey: String, productID: ProductCode) async throws {
        _ = try await native_photoImport_rejectCandidate(
            body:
                .init(
                    runId: runID, groupKey: groupKey, productId: productID,
                    operationId: UUID().uuidString)
        )
    }

    public func resolvePhotoConcern(runID: String, group: PhotoGroupProposal, reply: String) async throws {
        let revision = try LenientISO8601DateTranscoder().decode(group.updatedAt)
        let trimmed = reply.trimmingCharacters(in: .whitespacesAndNewlines)
        _ = try await native_photoImport_resolveConcern(
            body:
                .init(
                    runId: runID, groupKey: group.groupKey,
                    reply: trimmed.isEmpty ? nil : trimmed, expectedRevision: revision)
        )
    }
}
