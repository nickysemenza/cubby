import Foundation

/// The active filters of one entity list, keyed by wire parameter name (a `FilterDescriptor`'s
/// compiled `wire` name), so a filter sheet, a route, and the request all speak the same key.
/// Every value is a list: a scalar parameter holds one element, and an array parameter repeats
/// its key once per element (`tagFilters=a&tagFilters=b`). `EntityKernel.swift` types each list
/// from the kernel parameter, so a scalar route still receives a JSON scalar.
public struct EntityFilterState: Sendable, Hashable {
    public private(set) var values: [String: [String]]

    /// An empty string is never a value, so a parameter left with none is dropped.
    public init(_ values: [String: [String]] = [:]) {
        self.values = values.mapValues { $0.filter { !$0.isEmpty } }.filter { !$0.value.isEmpty }
    }

    public var isEmpty: Bool { values.isEmpty }

    /// How many parameters carry a value — the badge count on a Filter button.
    public var activeCount: Int { values.count }

    /// Parameter names in a stable order, for rendering and for deterministic request URLs.
    public var names: [String] { values.keys.sorted() }

    public subscript(name: String) -> [String]? { values[name] }

    /// Sets `value` for `name`; a list with no non-empty string removes the parameter instead.
    public mutating func set(_ value: [String], for name: String) {
        let value = value.filter { !$0.isEmpty }
        values[name] = value.isEmpty ? nil : value
    }

    public mutating func remove(_ name: String) {
        values[name] = nil
    }
}

extension EntityFilterState {
    /// Filters keyed by each declared URL key (`imageId`), mapped to the filter's wire parameter.
    /// A key the entity does not declare is dropped.
    public init(entity: EntityKey, urlFilters: [String: String]) {
        self.init()
        for (urlKey, value) in urlFilters {
            guard
                let name = EntityCatalog[entity].filters.first(where: { $0.urlKey == urlKey })?.wire.names
                    .first
            else { continue }
            set([value], for: name)
        }
    }
}

extension FilterDescriptor: Identifiable {
    /// `columnId` is unique within one entity's filters (the compiler checks it).
    public var id: String { columnId }
}

extension SavedView {
    /// The generator expands column filters into query parameters, including nullable presence.
    public var filterState: EntityFilterState { EntityFilterState(filters: filters) }

    public var sortParameter: String? {
        guard !sort.isEmpty else { return nil }
        return sort.map { ($0.desc ? "-" : "") + $0.id }.joined(separator: ",")
    }

    /// The declared list view this saved view opens in (`view: "shelf"`), when the entity offers it.
    public func listView(in descriptor: EntityDescriptor) -> ListView? {
        guard let view else { return nil }
        return descriptor.presentation.listViews.first { $0.id == view }
    }
}

extension EntityFilterState {
    /// Saved-view filters (a saved view, a presentation's `initialFilters`) keyed by wire name.
    public init(filters: [SavedViewFilter]) {
        self.init(Dictionary(filters.map { ($0.id, $0.values) }, uniquingKeysWith: { _, last in last }))
    }
}

extension EntityDescriptor {
    /// The filters a list opens with: a saved view's own, else the route's explicit filters,
    /// else the presentation's `initialFilters` (inventory opens on `placementFilter=stock`).
    public func openingFilters(savedView: SavedView?, explicit: EntityFilterState) -> EntityFilterState {
        if let savedView { return savedView.filterState }
        return explicit.isEmpty ? EntityFilterState(filters: presentation.initialFilters) : explicit
    }
}

/// Thrown by `EntityKernel.swift` when a filter cannot be sent.
public enum EntityFilterError: Error, Sendable, Hashable {
    /// The name is not a kernel filter of the entity.
    case unknownParameter(EntityKey, String)
    case invalidValue(parameter: String, value: String, expected: String)
}

// The conversions `EntityKernel.swift` and the USDA adapter apply to filter text. Each maps the
// wire string(s) onto the JSON kind the body carries; a value that kind cannot hold throws before
// any request is sent.
extension [String] {
    /// The one value a scalar parameter carries.
    func string(_ name: String) throws -> String {
        guard count == 1, let value = first else {
            throw EntityFilterError.invalidValue(
                parameter: name, value: joined(separator: ","), expected: "one value")
        }
        return value
    }

    func double(_ name: String) throws -> Double {
        let raw = try string(name)
        guard let value = Double(raw) else {
            throw EntityFilterError.invalidValue(parameter: name, value: raw, expected: "a number")
        }
        return value
    }

    func int(_ name: String) throws -> Int {
        let raw = try string(name)
        guard let value = Int(raw) else {
            throw EntityFilterError.invalidValue(parameter: name, value: raw, expected: "an integer")
        }
        return value
    }

    func bool(_ name: String) throws -> Bool {
        switch try string(name) {
        case "true", "1": return true
        case "false", "0": return false
        case let raw:
            throw EntityFilterError.invalidValue(parameter: name, value: raw, expected: "true or false")
        }
    }

    func enumCases<Case: RawRepresentable>(_ name: String) throws -> [Case] where Case.RawValue == String {
        try map { raw in
            guard let value = Case(rawValue: raw) else {
                throw EntityFilterError.invalidValue(
                    parameter: name, value: raw, expected: "one of the enum's cases")
            }
            return value
        }
    }
}
