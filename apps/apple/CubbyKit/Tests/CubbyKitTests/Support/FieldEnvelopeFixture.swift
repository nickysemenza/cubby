import Foundation

@testable import CubbyKit

/// Synthetic canonical field envelopes (`row.fields[key]`) in the server's public wire shape.
enum FieldEnvelopeFixture {
    static let record: JSONValue = ["kind": "record"]
    static let own: JSONValue = ["kind": "own", "ownership": record]
    static let idle: JSONValue = ["kind": "idle"]

    static func automatic(_ confidence: Double = 0.85) -> JSONValue {
        ["kind": "automatic", "receiptId": "RCPT-4K7M", "confidence": .number(confidence)]
    }

    static func value(_ value: JSONValue, ownership: JSONValue = record) -> JSONValue {
        ["kind": "value", "value": value, "ownership": ownership]
    }

    static let inherit: JSONValue = ["kind": "inherit"]
    static let none: JSONValue = ["kind": "none"]

    static func inherited(_ kind: String, _ id: String, _ name: String? = nil) -> JSONValue {
        [
            "kind": "inherited",
            "source": [
                "entityKind": .string(kind), "entityId": .string(id),
                "name": name.map(JSONValue.string) ?? .null,
            ],
        ]
    }

    static func readonly(_ reason: String) -> JSONValue { ["kind": "readonly", "reason": .string(reason)] }

    static func editable(
        canSetNone: Bool = false, canConfirm: Bool = false, reset: JSONValue = ["kind": "unavailable"]
    ) -> JSONValue {
        [
            "kind": "editable", "canSetNone": .bool(canSetNone), "canConfirm": .bool(canConfirm),
            "reset": reset,
        ]
    }

    static func resetReady(_ result: JSONValue) -> JSONValue {
        ["kind": "available", "preview": ["kind": "ready", "result": result]]
    }

    static let resetNotLoaded: JSONValue = ["kind": "available", "preview": ["kind": "not_loaded"]]

    static func decision(_ value: JSONValue, provenance: JSONValue = .null) -> JSONValue {
        ["outcome": ["kind": "value", "value": value], "provenance": provenance]
    }

    static func emptyDecision(_ reason: String, provenance: JSONValue = .null) -> JSONValue {
        ["outcome": ["kind": "empty", "reason": .string(reason)], "provenance": provenance]
    }

    static func live(_ decision: JSONValue) -> JSONValue { ["kind": "live", "decision": decision] }

    static func cached(_ decision: JSONValue, freshness: String) -> JSONValue {
        [
            "kind": "cached", "decision": decision, "computedAt": "2026-01-01T12:00:00.000Z",
            "freshness": .string(freshness),
        ]
    }

    static let missing: JSONValue = ["kind": "missing"]

    static func envelope(
        assignment: JSONValue = .null, controls: JSONValue = readonly("computed"), result: JSONValue,
        work: JSONValue = idle
    ) -> JSONValue {
        ["current": ["assignment": assignment, "controls": controls], "result": result, "work": work]
    }

    /// A record whose `fields` hold the given envelopes beside its ordinary keys.
    static func row(_ ordinary: [String: JSONValue] = [:], fields: [String: JSONValue]) -> JSONValue {
        var object = ordinary
        object["fields"] = .object(fields)
        return .object(object)
    }
}
