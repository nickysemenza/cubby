import Foundation

/// Consumer metadata over the frozen wire document. Reports own Run content; this seam reads
/// only routing, observation and the evidence required to authorize an explicitly reviewed fix.
public struct RunSnapshot: Codable, Sendable {
    public let raw: JSONValue
    public let runID: String
    public let purpose: String
    public let status: String
    public let operationErrors: [String]
    private let findings: [JSONRead]

    public init(_ raw: JSONValue) throws {
        let reader = JSONRead(value: raw, context: "Run snapshot")
        runID = try reader.string("runId")
        purpose = try reader.string("purpose")
        status = try reader.string("status")
        findings = try reader.array("findings")
        for finding in findings { _ = try finding.string("id") }
        operationErrors = try reader.array("operations").compactMap { operation in
            guard operation.value.objectValue != nil else {
                throw operation.malformed("", expected: "an operation object")
            }
            guard let error = operation.value["error"], error != .null else { return nil }
            return try operation.string("error")
        }
        self.raw = raw
    }

    public init(from decoder: any Decoder) throws {
        try self.init(JSONValue(from: decoder))
    }

    public func encode(to encoder: any Encoder) throws {
        try raw.encode(to: encoder)
    }

    func finding(id: String) -> JSONValue? {
        findings.first { $0.value["id"]?.stringValue == id }?.value
    }

    /// A control can finish without creating a successor. A malformed successor must not
    /// silently report success while dropping the new Run's navigation target.
    static func successorID(in raw: JSONValue) throws -> String? {
        guard let successor = raw["successor"], successor != .null else { return nil }
        return try JSONRead(value: successor, context: "Run control.successor").string("publicId")
    }
}
