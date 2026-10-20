import Foundation

/// Board presentation uses ordinary list filters, pages and declared commands.
public enum EntityBoardPlan {
    public static func pageSize(_ spec: BoardListSpec, groupBy: String, key: String) -> Int {
        spec.caps.first { $0.field == groupBy && $0.value == key }?.limit ?? spec.pageSize
    }

    public static func isCapped(_ spec: BoardListSpec, groupBy: String, key: String) -> Bool {
        spec.caps.contains { $0.field == groupBy && $0.value == key }
    }

    public static func sortParameter(_ spec: BoardListSpec, groupBy: String, key: String) -> String {
        if let cap = spec.caps.first(where: { $0.field == groupBy && $0.value == key }),
            let orderBy = cap.orderBy
        {
            return (cap.direction == "asc" ? "" : "-") + orderBy
        }
        return spec.sort.map { ($0.direction == "desc" ? "-" : "") + $0.orderBy }.joined(separator: ",")
    }

    public static func scope(_ filters: EntityFilterState, spec: BoardListSpec) -> EntityFilterState {
        var result = filters
        for (key, value) in spec.filters {
            let strings: [String]
            switch value {
            case .string(let value): strings = [value]
            case .bool(let value): strings = [value ? "true" : "false"]
            default: strings = value.arrayValue?.compactMap(\.stringValue) ?? []
            }
            result.set(strings, for: key)
        }
        return result
    }

    /// The server resolves anchors against the complete group, including unseen pages.
    public static func drop(
        rows: [JSONValue], id: String, before: String?, group: [String: JSONValue],
        move: Bool = false
    ) -> JSONValue {
        let ordered = rows.filter { $0["id"]?.stringValue != id }
        let index =
            before.flatMap { target in ordered.firstIndex { $0["id"]?.stringValue == target } }
            ?? ordered.count
        let previous = index > 0 ? ordered[index - 1]["id"]?.stringValue : nil
        let next = index < ordered.count ? ordered[index]["id"]?.stringValue : nil
        var body: [String: JSONValue] = [
            "position": [
                "id": .string(id), "before": next.map(JSONValue.string) ?? .null,
                "after": previous.map(JSONValue.string) ?? .null, "group": .object(group),
            ]
        ]
        if move { body["move"] = ["id": .string(id), "patch": .object(group)] }
        return .object(body)
    }
}
