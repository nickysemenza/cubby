import CubbyAPI
import Foundation
import OpenAPIRuntime

/// The error CubbyKit throws for any HTTP response with status >= 400.
///
/// Every error status in `/api/v1` carries one bare `ApiError` body — there is no `{ok:false}`
/// envelope. `detail` is `nil` whenever the body isn't that shape (a 502 from an intermediary
/// proxy, for example, is usually an HTML error page).
public struct CubbyAPIError: Error, LocalizedError, Sendable {
    public let status: Int
    public let operationID: String
    public let detail: ErrorDetail?

    public init(status: Int, operationID: String, detail: ErrorDetail?) {
        self.status = status
        self.operationID = operationID
        self.detail = detail
    }

    /// `true` for a 401 response — callers use this to drop the stored credential and return to
    /// LoginView.
    public var isUnauthorized: Bool {
        status == 401
    }

    /// `inventory.reconcileSession` refused because the bin changed since it was read: 409 with
    /// `reason == "INVENTORY_STALE"` (the `code` is the generic `CONFLICT`).
    public var isStaleInventory: Bool {
        status == 409 && detail?.reason == "INVENTORY_STALE"
    }

    /// The body's `reason`, when the server sent one.
    public var reason: String? { detail?.reason }

    /// User-facing text from Cubby's canonical API error body. Falling back to the HTTP status
    /// keeps SwiftUI from rendering the opaque `CubbyKit.CubbyAPIError error 1` description when
    /// an intermediary returned HTML or an empty body.
    public var errorDescription: String? {
        detail?.message ?? "Cubby could not complete this request (HTTP \(status))."
    }

    public var failureReason: String? {
        detail?.requestId.map { "Request \($0)" } ?? operationID
    }

    public var recoverySuggestion: String? {
        switch status {
        case 401:
            "Sign in again, then retry."
        case 409:
            "Refresh the record, review the latest values, and retry."
        case 429:
            "Wait a moment, then retry."
        case 500...599:
            "Try again. If this continues, contact support."
        default:
            nil
        }
    }

    /// One entry of `ApiError.validationIssues`. The wire path mixes object keys and array
    /// indices, so both arrive here spelled as strings.
    public struct ValidationIssue: Decodable, Sendable, Hashable {
        public let code: String
        public let path: [String]
        public let message: String

        public init(code: String, path: [String], message: String) {
            self.code = code
            self.path = path
            self.message = message
        }

        private enum CodingKeys: String, CodingKey { case code, path, message }

        public init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            code = try container.decode(String.self, forKey: .code)
            message = try container.decode(String.self, forKey: .message)
            var elements = try container.nestedUnkeyedContainer(forKey: .path)
            var path: [String] = []
            while !elements.isAtEnd {
                if let key = try? elements.decode(String.self) {
                    path.append(key)
                } else {
                    path.append(String(Int(try elements.decode(Double.self))))
                }
            }
            self.path = path
        }
    }

    /// The `ApiError` body, hand-decoded so a body that is merely *shaped* like JSON still
    /// degrades to `detail == nil` instead of throwing out of an error path.
    public struct ErrorDetail: Decodable, Sendable {
        public let code: String
        public let message: String
        public let reason: String?
        public let requestId: String?
        public let validationIssues: [ValidationIssue]?

        public init(
            code: String,
            message: String,
            reason: String? = nil,
            requestId: String? = nil,
            validationIssues: [ValidationIssue]? = nil
        ) {
            self.code = code
            self.message = message
            self.reason = reason
            self.requestId = requestId
            self.validationIssues = validationIssues
        }
    }

    /// Decodes a raw response body into a `CubbyAPIError`. A body that isn't an `ApiError`
    /// object (an HTML error page, an empty body, plain text) decodes to `detail == nil` rather
    /// than throwing.
    public static func decode(status: Int, operationID: String, body: Data) -> CubbyAPIError {
        let detail = try? JSONDecoder().decode(ErrorDetail.self, from: body)
        return CubbyAPIError(status: status, operationID: operationID, detail: detail)
    }

    /// OpenAPIRuntime wraps everything thrown inside the transport or a middleware in a
    /// `ClientError`, which would hide the `isUnauthorized`/`isStaleInventory` a caller switches
    /// on. This unwraps ours; a transport failure that still carried a status becomes a bodyless
    /// `CubbyAPIError`, and anything else is returned untouched.
    public static func unwrapping(_ error: any Error) -> any Error {
        guard let client = error as? ClientError else { return error }
        if let api = client.underlyingError as? CubbyAPIError { return api }
        guard let status = client.response?.status.code, status >= 400 else { return error }
        return CubbyAPIError(status: status, operationID: client.operationID, detail: nil)
    }
}
