import CubbyAPI
import Foundation

/// The server calls a walk needs beyond scanning. `CubbyClient` conforms; tests stub it.
public protocol AuditService: Sendable {
    func locationTree() async throws -> LocationTree
    /// The global "Unknown" location, created on first use. Relocation target for stock that
    /// belongs nowhere you can name.
    func ensureGlobalUnknown() async throws -> LocationCode
    /// The bin's expected rows: movable stock only. Installed rows are fixed installations the
    /// server excludes from counting and audits (`placement.ts`).
    func stockSnapshot(at location: LocationCode) async throws -> RecountSnapshot
    /// Products stocked in more than one location, for the Duplicate badge.
    func duplicateProductIDs() async throws -> Set<ProductCode>
    func reconcile(_ body: ReconcileSessionPayload) async throws -> [RecountRow]
    /// Re-parents bins under `parent`. Returns how many changed.
    func adopt(_ bins: [LocationCode], into parent: LocationCode) async throws -> Int
}

public typealias RecountService = AuditService & ScanService

extension CubbyClient: AuditService {
    public func ensureGlobalUnknown() async throws -> LocationCode {
        try await ensureGlobalUnknownLocation()
    }

    public func stockSnapshot(at location: LocationCode) async throws -> RecountSnapshot {
        try await inventorySnapshot(at: location)
    }

    public func duplicateProductIDs() async throws -> Set<ProductCode> {
        try await findDuplicates()
    }

    public func adopt(_ bins: [LocationCode], into parent: LocationCode) async throws -> Int {
        try await bulkUpdateParent(bins, to: parent)
    }
}
