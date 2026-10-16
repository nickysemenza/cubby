import CubbyAPI
import Foundation

extension CubbyClient {
    public func savePhotoGroups(runID: String, groups: [JSONValue]) async throws -> ReviewPhotoGroupsOutput {
        let body: JSONValue = ["runId": .string(runID), "groups": .array(groups)]
        return try await perform {
            try await sending(body) { input in
                try await api.photoImport_saveGroups(body: .json(input)).ok.body.json
            }
        }
    }

    public func photoCandidateGroups(runID: String) async throws -> [String: PhotoCandidateGroupResult] {
        try await perform {
            let response = try await api.photoImport_candidatesBatch(query: .init(runId: runID)).ok.body.json
            return Dictionary(uniqueKeysWithValues: response.groups.map { ($0.groupKey, $0) })
        }
    }

    public func photoEvidence(runID: String, productID: ProductCode) async throws -> PhotoProductEvidence {
        try await perform {
            try await api.photoImport_productEvidence(
                query: .init(runId: runID, productId: productID.rawValue)
            )
            .ok.body.json
        }
    }

    public func rejectPhotoCandidate(runID: String, groupKey: String, productID: ProductCode) async throws {
        _ = try await perform {
            try await api.photoImport_rejectCandidate(
                body: .json(
                    .init(
                        runId: runID, groupKey: groupKey, productId: productID,
                        operationId: UUID().uuidString))
            ).ok.body.json
        }
    }

    public func resolvePhotoConcern(runID: String, group: PhotoGroupProposal, reply: String) async throws {
        let revision = try LenientISO8601DateTranscoder().decode(group.updatedAt)
        let trimmed = reply.trimmingCharacters(in: .whitespacesAndNewlines)
        _ = try await perform {
            try await api.photoImport_resolveConcern(
                body: .json(
                    .init(
                        runId: runID, groupKey: group.groupKey,
                        reply: trimmed.isEmpty ? nil : trimmed, expectedRevision: revision))
            ).ok.body.json
        }
    }
}
