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
    /// The target field that references the source record, when the target declares one; the
    /// generic create editor prefills it so a record added from this section lands here.
    public let referenceField: FieldDescriptor?
    private let prefillIsMany: Bool?
    public let list: GenericEntityListModel

    /// `nil` when `section` is not a relation section, the relation is undeclared on `source`, or
    /// the target has no descriptor by the section's name — each a compiler-checked declaration
    /// fact, so a nil here means the catalog and the declaration disagree.
    public init?(
        section: DetailSection,
        source: EntityDescriptor,
        recordID: String,
        client: CubbyClient
    ) {
        guard case .relation(let spec) = section.kind,
            let relation = source.relation(spec.relation)
        else { return nil }
        let target = EntityCatalog[relation.target]
        guard let filter = target.filter(spec.filterDescriptor),
            case .param(let wireName) = filter.wire
        else { return nil }
        self.id = section.id
        self.section = section
        self.spec = spec
        self.source = source
        self.recordID = recordID
        self.target = target
        // The generic seed rule: when the filter's own column is a real create field on the
        // target (a direct filter like `locationId`), seed that; otherwise (a derived/urlOnly
        // filter like `journalPlantingId`) fall back to the target's single reference field whose
        // `reference.entity` matches the filter's brandRef entity. Sections with an ambiguous or
        // multiple reference use the generated explicit prefill field instead.
        let explicitField = spec.prefill.flatMap { target.field($0.field) }
        self.referenceField =
            explicitField
            ?? (spec.prefill == nil
                ? target.field(filter.columnId)
                    ?? filter.targetEntity.flatMap { brandEntity in
                        target.fields.first {
                            $0.reference?.entity == brandEntity
                        }
                    }
                : nil)
        self.prefillIsMany = referenceField?.reference?.multiple
        let sort = spec.sort.map { $0.direction == .desc ? "-\($0.field)" : $0.field }
        self.list = GenericEntityListModel(
            descriptor: target,
            client: client,
            pageSize: spec.limit ?? 25,
            sort: sort,
            filters: EntityFilterState([wireName: .single(recordID)]),
            view: .table
        )
    }

    /// The draft the section's create button opens the editor with.
    public var createPrefill: [String: JSONValue] {
        guard let referenceField else { return [:] }
        let value: JSONValue =
            prefillIsMany == true
            ? .array([.string(recordID)])
            : .string(recordID)
        return [referenceField.key: value]
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
