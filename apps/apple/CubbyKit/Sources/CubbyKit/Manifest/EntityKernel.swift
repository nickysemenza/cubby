import CubbyAPI
import Foundation

/// Thrown when a catalog entity does not support the requested kernel action.
public enum EntityOperationError: Error, Sendable, Hashable {
    case unsupported(EntityKey, EntityAction)
    /// A create response whose item carries no string `id`.
    case missingCreatedID(EntityKey)
}

/// How the native client reads an entity: the entity kernel, the one exceptional USDA adapter,
/// or not at all.
public enum NativeReadKind: String, Sendable, Hashable, Decodable {
    case unavailable, kernel, usdaFood
}

/// One entity's native capabilities, from `Generated/entity-kernel.json` (written by
/// `apps/web/generator/http-api/entity-kernel.ts` from the entity declarations).
struct EntityKernelCapabilities: Decodable, Sendable {
    /// One flat filter name: its place in the list body and the JSON kind it travels as.
    struct Parameter: Decodable, Sendable {
        enum Kind: String, Decodable, Sendable { case string, number, integer, boolean, strings }
        let path: [String]
        let type: Kind
        let values: [String]?
    }

    let actions: Set<EntityAction>
    let nativeActions: Set<EntityAction>
    let read: NativeReadKind
    let imageAttach: Bool
    let imageOrder: Bool
    let parameters: [String: Parameter]
    let groupBy: [String]
}

enum EntityKernelCatalog {
    static let all: [EntityKey: EntityKernelCapabilities] = {
        guard let url = Bundle.module.url(forResource: "entity-kernel", withExtension: "json") else {
            fatalError("entity-kernel.json is missing from the CubbyKit bundle; run `pnpm generate`.")
        }
        do {
            let decoded = try JSONDecoder().decode(
                [String: EntityKernelCapabilities].self, from: Data(contentsOf: url))
            return Dictionary(
                uniqueKeysWithValues: decoded.compactMap { key, value in
                    EntityKey(rawValue: key).map { ($0, value) }
                })
        } catch {
            fatalError("entity-kernel.json does not decode: \(error)")
        }
    }()
}

extension EntityKey {
    fileprivate var kernel: EntityKernelCapabilities? { EntityKernelCatalog.all[self] }

    /// The kernel actions the HTTP API serves for this entity.
    public var httpActions: Set<EntityAction> { kernel?.actions ?? [] }

    /// What the native client can do: `httpActions` plus an entity-domain `list`/`detail` RPC.
    public var nativeActions: Set<EntityAction> { kernel?.nativeActions ?? [] }

    public var nativeReadKind: NativeReadKind { kernel?.read ?? .unavailable }

    /// Whether the entity's update accepts `pendingImageIds`.
    public var acceptsImageAttach: Bool { kernel?.imageAttach ?? false }
}

extension EntityDescriptor {
    /// The kernel list body (`entity.list`, `entity.listBase`, `entity.listSummary`): flat
    /// filter names re-nested and typed from the catalog, a 1-based page as the 0-based
    /// `pageIndex`, and `sort` (`name,-createdAt`) as `[{orderBy, direction}]`.
    func listInput(page: Int, pageSize: Int, sort: String?, filters: EntityFilterState) throws -> JSONValue {
        var input: [String: JSONValue] = [
            "entity": .string(key.rawValue),
            "filters": .object(try filterBody(filters, includeWindow: false)),
            "pagination": .object([
                "pageIndex": .number(Double(max(0, page - 1))), "pageSize": .number(Double(pageSize)),
            ]),
        ]
        if let sort {
            input["sort"] = .array(
                sort.split(separator: ",").map { field in
                    .object([
                        "orderBy": .string(field.hasPrefix("-") ? String(field.dropFirst()) : String(field)),
                        "direction": .string(field.hasPrefix("-") ? "desc" : "asc"),
                    ])
                })
        }
        if let group = filters["groupBy"] { input["groupBy"] = .string(try group.string("groupBy")) }
        return .object(input)
    }

    /// The values a filter accepts when its catalog `options` are nil (the server supplies
    /// them); nil when `wireKey` is not an enum filter.
    public func filterValues(for wireKey: String) -> [String]? {
        key.kernel?.parameters[wireKey]?.values
    }

    /// One page of rows as the dynamic projection `EntityRow` reads.
    func listPage(
        client: Client, page: Int, pageSize: Int, sort: String?, filters: EntityFilterState
    ) async throws -> ListPage<JSONValue> {
        try require(.list)
        let body = try listInput(page: page, pageSize: pageSize, sort: sort, filters: filters)
        let response = try JSONValue(
            encoding: try await client.entity_list(body: .json(body.decoded())).ok.body.json)
        guard let meta = response["meta"] else { throw EntityOperationError.unsupported(key, .list) }
        return ListPage(items: response["items"]?.arrayValue ?? [], meta: try meta.decoded())
    }

    /// `entity.timeline` over the same filter state as `listPage`, plus `ids`, `from`, `to` and
    /// `order` under their own names.
    func timeline(client: Client, filters: EntityFilterState) async throws -> EntityTimelineOut {
        try require(.timeline)
        var body = try filterBody(filters, includeWindow: true)
        let window = body.removeValue(forKey: "window") ?? .object([:])
        let input: JSONValue = .object([
            "entity": .string(key.rawValue), "filters": .object(body), "window": window,
            "pagination": .object([:]),
        ])
        return try await client.entity_timeline(body: .json(input.decoded())).ok.body.json
    }

    /// One row by shortcode, as the dynamic projection `EntityRow` reads.
    func getRow(client: Client, id: String) async throws -> JSONValue {
        try require(.get)
        let input: JSONValue = ["entity": .string(key.rawValue), "shortcode": .string(id)]
        return try JSONValue(
            encoding: try await client.entity_detail(body: .json(input.decoded())).ok.body.json)
    }

    /// `entity.mutate` create; returns the new record's id. The server parses `body` with the
    /// entity's create schema, so an unknown key is its 400.
    func create(_ body: JSONValue, client: Client) async throws -> String {
        try require(.create)
        let result = try await mutate(
            ["action": "create", "entity": .string(key.rawValue), "data": body], client)
        guard let id = result["item"]?["id"]?.stringValue else {
            throw EntityOperationError.missingCreatedID(key)
        }
        return id
    }

    /// `entity.mutate` update with a partial body; `null` clears a field.
    func update(_ body: JSONValue, id: String, client: Client) async throws {
        try require(.update)
        _ = try await mutate(
            ["action": "update", "entity": .string(key.rawValue), "id": .string(id), "data": body], client)
    }

    /// `entity.mutate` delete. Destructive: only the hero-action runner calls it, behind an
    /// explicit confirmation.
    func delete(id: String, client: Client) async throws {
        try require(.delete)
        _ = try await mutate(
            ["action": "delete", "entity": .string(key.rawValue), "ids": .array([.string(id)])], client)
    }

    /// An update carrying only `pendingImageIds`, for entities whose update declares it.
    func attachImages(_ imageIds: [ImageCode], to id: String, client: Client) async throws {
        guard key.kernel?.imageAttach == true else { throw EntityOperationError.unsupported(key, .update) }
        try await update(
            ["pendingImageIds": .array(imageIds.map { .string($0.rawValue) })], id: id, client: client)
    }

    /// An update carrying only `imageOrder`.
    func setImageOrder(_ imageIds: [ImageCode], on id: String, client: Client) async throws {
        guard key.kernel?.imageOrder == true else { throw EntityOperationError.unsupported(key, .update) }
        try await update(
            ["imageOrder": .array(imageIds.map { .string($0.rawValue) })], id: id, client: client)
    }

    private func require(_ action: EntityAction) throws {
        guard key.httpActions.contains(action) else { throw EntityOperationError.unsupported(key, action) }
    }

    private func mutate(_ command: JSONValue, _ client: Client) async throws -> JSONValue {
        try JSONValue(encoding: try await client.entity_mutate(body: .json(command.decoded())).ok.body.json)
    }

    /// Flat filter names as the kernel's nested, typed `filters` object. A timeline's window
    /// names land under `window`.
    func filterBody(_ filters: EntityFilterState, includeWindow: Bool) throws -> [String: JSONValue] {
        let parameters = key.kernel?.parameters ?? [:]
        var result: [String: JSONValue] = [:]
        for name in filters.names where name != "groupBy" {
            guard let value = filters[name] else { continue }
            guard let parameter = parameters[name], includeWindow || parameter.path.first != "window" else {
                throw EntityFilterError.unknownParameter(key, name)
            }
            let converted = try parameter.json(value, name: name)
            switch parameter.path.count {
            case 1: result[parameter.path[0]] = converted
            default:
                var nested = result[parameter.path[0]]?.objectValue ?? [:]
                nested[parameter.path[1]] = converted
                result[parameter.path[0]] = .object(nested)
            }
        }
        return result
    }
}

extension EntityKernelCapabilities.Parameter {
    fileprivate func json(_ value: [String], name: String) throws -> JSONValue {
        let check = { (raw: String) throws -> String in
            if let values, !values.contains(raw) {
                throw EntityFilterError.invalidValue(
                    parameter: name, value: raw, expected: "one of \(values.joined(separator: ", "))")
            }
            return raw
        }
        switch type {
        case .string: return .string(try check(try value.string(name)))
        case .strings: return .array(try value.map { .string(try check($0)) })
        case .number: return .number(try value.double(name))
        case .integer: return .number(Double(try value.int(name)))
        case .boolean: return .bool(try value.bool(name))
        }
    }
}

extension JSONValue {
    func decoded<T: Decodable>() throws -> T {
        try JSONDecoder.cubby().decode(T.self, from: JSONEncoder.cubby().encode(self))
    }
}
