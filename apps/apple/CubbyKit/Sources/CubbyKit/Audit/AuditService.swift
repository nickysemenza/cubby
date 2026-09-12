import Foundation

/// The server calls a walk needs beyond scanning. `CubbyClient` conforms; tests stub it.
public protocol AuditService: Sendable {
    func locationTree() async throws -> LocationTree
    /// The global "Unknown" location, created on first use. Relocation target for stock that
    /// belongs nowhere you can name.
    func ensureGlobalUnknown() async throws -> LocationCode
    /// The bin's expected rows: movable stock only. Installed rows are fixed installations the
    /// server excludes from counting and audits (`placement.ts`).
    func stockRows(at location: LocationCode) async throws -> [RecountRow]
    /// Products stocked in more than one location, for the Duplicate badge.
    func duplicateProductIDs() async throws -> Set<ProductCode>
    func reconcile(_ body: ReconcileBody) async throws -> [RecountRow]
    /// Re-parents bins under `parent`. Returns how many changed.
    func adopt(_ bins: [LocationCode], into parent: LocationCode) async throws -> Int
}

public typealias RecountService = AuditService & ScanService

extension CubbyClient: AuditService {
    public func locationTree() async throws -> LocationTree {
        LocationTree(roots: try await raw.call("location.makeTree", as: [LocationTreeNode].self))
    }

    public func ensureGlobalUnknown() async throws -> LocationCode {
        struct Created: Decodable { let id: LocationCode }
        return try await raw.call("location.ensureGlobalUnknown", body: .object([:]), as: Created.self).id
    }

    public func stockRows(at location: LocationCode) async throws -> [RecountRow] {
        try await raw.call(
            "inventory.getByLocationIds",
            query: ["locationIds": .array([.string(location.rawValue)]), "placement": .string("stock")],
            as: [RecountRow].self
        )
    }

    public func duplicateProductIDs() async throws -> Set<ProductCode> {
        struct Duplicate: Decodable { let id: ProductCode }
        return Set(try await raw.call("inventory.findDuplicates", as: [Duplicate].self).map(\.id))
    }

    public func reconcile(_ body: ReconcileBody) async throws -> [RecountRow] {
        struct Result: Decodable { let items: [RecountRow] }
        return try await raw.call("inventory.reconcileSession", body: body, as: Result.self).items
    }

    public func adopt(_ bins: [LocationCode], into parent: LocationCode) async throws -> Int {
        struct Updated: Decodable { let updated: Int }
        let body: JSONValue = [
            "ids": .array(bins.map { .string($0.rawValue) }),
            "parentId": .string(parent.rawValue),
        ]
        return try await raw.call("location.bulkUpdateParent", body: body, as: Updated.self).updated
    }
}
