import Foundation

/// Local row intent. Baseline keys survive text editing; the existing repository applies the patch.
public struct CollectionEdit: Codable, Sendable {
    public struct Row: Codable, Sendable {
        public var baseline: [String: JSONValue]?
        public var value: [String: JSONValue]?
        public var primaryIntent: Bool
        public var replacing: Bool

        public init(baseline: [String: JSONValue]?, value: [String: JSONValue]?) {
            self.baseline = baseline
            self.value = value
            self.primaryIntent = false
            self.replacing = false
        }
    }

    public var creating: Bool
    public var rows: [Row]

    public init(value: JSONValue, creating: Bool) {
        self.creating = creating
        self.rows = (value.arrayValue ?? []).compactMap { value in
            value.objectValue.map { Row(baseline: creating ? nil : $0, value: $0) }
        }
    }

    public static func decode(_ value: JSONValue?) -> Self? {
        guard let state = value?["collectionEdit"] else { return nil }
        return try? state.decoded(Self.self)
    }

    public var json: JSONValue {
        .object([
            "collectionEdit": .object([
                "creating": .bool(creating),
                "rows": .array(
                    rows.map { row in
                        .object([
                            "baseline": row.baseline.map(JSONValue.object) ?? .null,
                            "value": row.value.map(JSONValue.object) ?? .null,
                            "primaryIntent": .bool(row.primaryIntent), "replacing": .bool(row.replacing),
                        ])
                    }),
            ])
        ])
    }

    public enum EditError: LocalizedError {
        case duplicateTarget
        case missingBaseline
        public var errorDescription: String? {
            switch self {
            case .duplicateTarget: "This identifier already exists. Remove a row explicitly to retire it."
            case .missingBaseline: "Load the saved collection before editing identifiers."
            }
        }
    }

    private func pick(_ row: [String: JSONValue], _ keys: [String]) -> [String: JSONValue] {
        row.filter { keys.contains($0.key) }
    }

    /// Create has a full initial value. Selecting its first primary is materialization, not edit intent.
    public func initialValue(
        collection: FieldCollection, normalize: ([String: JSONValue]) throws -> [String: JSONValue]
    ) -> JSONValue {
        let active = rows.filter { $0.value != nil }
        var scopes: [[String: JSONValue]] = []
        return .array(
            active.enumerated().compactMap { index, row in
                guard let raw = row.value else { return nil }
                var value = (try? normalize(raw)) ?? raw
                if let primary = collection.primary {
                    let scope = pick(value, primary.scope)
                    let explicit = active.firstIndex { other in
                        guard other.primaryIntent, let candidate = other.value else { return false }
                        return pick((try? normalize(candidate)) ?? candidate, primary.scope) == scope
                    }
                    value[primary.key] = .bool(explicit.map { $0 == index } ?? !scopes.contains(scope))
                    scopes.append(scope)
                }
                return .object(value)
            })
    }

    public func wireValue(
        collection: FieldCollection, attributes: [String],
        normalize: ([String: JSONValue]) throws -> [String: JSONValue]
    ) throws -> JSONValue {
        let normalized = try rows.map { row -> Row in
            var result = row
            result.baseline = try row.baseline.map(normalize)
            result.value = try row.value.map(normalize)
            return result
        }
        var seen: [[String: JSONValue]] = []
        for row in normalized {
            guard let value = row.value else { continue }
            let key = pick(value, collection.key)
            guard !seen.contains(key) else { throw EditError.duplicateTarget }
            seen.append(key)
            if let baseline = row.baseline, pick(baseline, collection.key) != key,
                normalized.contains(where: { $0.baseline.map { pick($0, collection.key) == key } ?? false })
            {
                throw EditError.duplicateTarget
            }
        }
        if let primary = collection.primary {
            let requests = normalized.filter { $0.primaryIntent && $0.value != nil }
            for (index, row) in requests.enumerated() {
                if requests.prefix(index).contains(where: {
                    pick($0.value ?? [:], primary.scope) == pick(row.value ?? [:], primary.scope)
                }) {
                    throw EditError.duplicateTarget
                }
            }
        }
        if creating { return initialValue(collection: collection, normalize: normalize) }
        var patches: [JSONValue] = []
        for row in normalized {
            let before = row.baseline
            let after = row.value
            let changedIdentity =
                before != nil && after != nil
                && pick(before ?? [:], collection.key) != pick(after ?? [:], collection.key)
            let expect = pick(before ?? [:], attributes)
            if let before, after == nil || changedIdentity {
                patches.append(
                    .object([
                        "op": "remove", "key": .object(pick(before, collection.key)),
                        "expect": .object(expect),
                    ]))
            }
            guard let after else { continue }
            var attrs = pick(after, attributes)
            if let primary = collection.primary {
                attrs.removeValue(forKey: primary.key)
                if row.primaryIntent {
                    attrs[primary.key] = true
                } else if changedIdentity {
                    let promotedSibling = normalized.contains {
                        $0.primaryIntent
                            && $0.value.map { pick($0, primary.scope) == pick(after, primary.scope) } == true
                    }
                    attrs[primary.key] = promotedSibling ? false : before?[primary.key] ?? false
                }
            }
            if before == nil || changedIdentity {
                patches.append(
                    .object([
                        "op": "add", "key": .object(pick(after, collection.key)), "value": .object(attrs),
                    ]))
            } else if let before {
                var changed = attrs.filter { before[$0.key] != $0.value }
                if let primary = collection.primary, row.primaryIntent { changed[primary.key] = true }
                if !changed.isEmpty {
                    patches.append(
                        .object([
                            "op": "replace", "key": .object(pick(before, collection.key)),
                            "value": .object(changed), "expect": .object(expect),
                        ]))
                }
            }
        }
        return .array(patches)
    }
}
