import CubbyKit

/// A reference picker scope emitted by the entity manifest. `ready == false`
/// means a declared dependent field is empty; callers must keep the picker
/// closed rather than widening the candidate query.
struct EntityPickerScope: Hashable {
    let filters: EntityFilterState
    let ready: Bool
}

enum EntityReferenceScope {
    static func pickerScope(
        field: FieldDescriptor, draft: [String: JSONValue]
    ) -> EntityPickerScope? {
        guard let reference = field.reference else { return nil }
        let bindings = reference.scope
        guard !bindings.isEmpty || !reference.filters.isEmpty else {
            return nil
        }
        var filters: [String: EntityFilterValue] = [:]
        for filter in reference.filters {
            filters[filter.field] =
                filter.values.count == 1 ? .single(filter.values[0]) : .many(filter.values)
        }
        for binding in bindings {
            guard let value = draft[binding.sourceField],
                let strings = values(from: value),
                !strings.isEmpty
            else {
                return EntityPickerScope(filters: EntityFilterState(filters), ready: false)
            }
            filters[binding.targetField] =
                strings.count == 1
                ? .single(strings[0])
                : .many(strings)
        }
        return EntityPickerScope(filters: EntityFilterState(filters), ready: true)
    }

    private static func values(from value: JSONValue) -> [String]? {
        if let string = value.stringValue, !string.isEmpty { return [string] }
        return value.arrayValue?.compactMap(\.stringValue).filter { !$0.isEmpty }
    }
}
