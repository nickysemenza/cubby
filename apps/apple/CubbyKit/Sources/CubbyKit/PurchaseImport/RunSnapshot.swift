import Foundation

/// Consumer metadata over the frozen wire document. Reports own Run content; this seam reads
/// only routing and observation.
public struct RunSnapshot: Codable, Sendable {
    public let raw: JSONValue
    public let runID: String
    public let purpose: RunPurpose
    public let status: RunStatus
    public let operationErrors: [String]

    public init(_ raw: JSONValue) throws {
        let reader = JSONRead(value: raw, context: "Run snapshot")
        runID = try reader.string("runId")
        let purpose = RunPurpose(rawValue: try reader.string("purpose"))
        guard RunPurpose.allCases.contains(purpose) else {
            throw reader.malformed("purpose", expected: "a Run purpose")
        }
        self.purpose = purpose
        let status = RunStatus(rawValue: try reader.string("status"))
        guard RunStatus.allCases.contains(status) else {
            throw reader.malformed("status", expected: "a Run status")
        }
        self.status = status
        for finding in try reader.array("findings") { _ = try finding.string("id") }
        operationErrors = try reader.array("operations").compactMap { operation in
            guard operation.value.objectValue != nil else {
                throw operation.malformed("", expected: "an operation object")
            }
            guard let error = operation.value["error"], error != .null else { return nil }
            guard let message = error.stringValue else {
                throw operation.malformed("error", expected: "a string")
            }
            return message
        }
        self.raw = raw
    }

    public init(from decoder: any Decoder) throws {
        try self.init(JSONValue(from: decoder))
    }

    public func encode(to encoder: any Encoder) throws {
        try raw.encode(to: encoder)
    }

}
