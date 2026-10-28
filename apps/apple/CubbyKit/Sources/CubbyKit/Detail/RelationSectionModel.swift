import Observation

/// One declared relation section on a detail screen: the target entity's list filtered against
/// the shown record through the section's filter descriptor. Wraps a `GenericEntityListModel` so
/// the section pages, filters and refreshes exactly like the target's own list.
@MainActor
@Observable
public final class RelationSectionModel: Identifiable {
    public let id: String
    public let section: DetailSection
    public let spec: RelationSectionSpec
    public let source: EntityDescriptor
    public let recordID: String
    public let target: EntityDescriptor
    /// The compiler-selected create intent's writable roster.
    public var createFields: [String]? { spec.plan.seed?.fields }
    public let list: GenericEntityListModel
    public private(set) var connectionEvidence: [String: ConnectedRecord] = [:]
    public private(set) var connectionError: String?
    private let client: CubbyClient

    /// Non-relation sections have no relation list; all relation semantics are compiler-resolved.
    public init?(
        section: DetailSection,
        source: EntityDescriptor,
        recordID: String,
        client: CubbyClient
    ) {
        guard case .relation(let spec) = section.kind else { return nil }
        let plan = spec.plan
        let target = EntityCatalog[plan.target]
        self.id = section.id
        self.section = section
        self.spec = spec
        self.source = source
        self.recordID = recordID
        self.client = client
        self.target = target
        let sort = plan.sort.direction == .desc ? "-\(plan.sort.field)" : plan.sort.field
        var scope = EntityFilterState([plan.filterKey: [recordID]])
        if let subtree = plan.subtree { scope.set(["false"], for: subtree) }
        self.list = GenericEntityListModel(
            descriptor: target,
            client: client,
            pageSize: plan.pageSize,
            sort: sort,
            filters: scope,
            view: .table,
            groupBy: plan.groupBy
        )
    }

    /// The draft the section's create button opens the editor with.
    public var createPrefill: [String: JSONValue] {
        guard let seed = spec.plan.seed else { return [:] }
        let value: JSONValue =
            spec.plan.seedMultiple
            ? .array([.string(recordID)])
            : .string(recordID)
        return [seed.field: value]
    }

    public func loadConnectionEvidence() async {
        let ids = list.rows.map(\.id)
        guard !ids.isEmpty else { return }
        do {
            var evidence: [String: ConnectedRecord] = [:]
            for start in stride(from: 0, to: ids.count, by: 50) {
                let page = try await client.connectedRecords(
                    source: EntityRef(entity: source.key, id: recordID),
                    viewKey: "relation:\(spec.relation)", limit: 50,
                    targetIDs: Array(ids[start..<min(start + 50, ids.count)])
                )
                for item in page.items { evidence[item.target.entityId] = item }
            }
            connectionEvidence = evidence
            connectionError = nil
        } catch {
            connectionError = String(describing: error)
        }
    }

    /// The declared relation sections of `descriptor`, each bound to `recordID`.
    public static func sections(
        of descriptor: EntityDescriptor, recordID: String, client: CubbyClient
    ) -> [RelationSectionModel] {
        descriptor.presentation.detailSections.compactMap {
            RelationSectionModel(
                section: $0, source: descriptor, recordID: recordID, client: client
            )
        }
    }
}
