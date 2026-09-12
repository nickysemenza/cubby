import Foundation

/// The error CubbyAuthMiddleware throws for any HTTP response with status >= 400.
///
/// `detail` is `nil` whenever the response body isn't Cubby's `{ok:false,error:{...}}` envelope
/// (a 502 from an intermediary proxy, for example, is usually an HTML error page).
public struct CubbyAPIError: Error, Sendable {
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

    public struct ErrorDetail: Decodable, Sendable {
        public let code: String
        public let message: String
        public let reason: String?
        public let requestId: String?
    }

    /// Decodes a raw response body into a `CubbyAPIError`. `body` that isn't Cubby's
    /// `{ok:false,error:{...}}` envelope (an HTML error page, an empty body, plain text) decodes
    /// to `detail == nil` rather than throwing.
    public static func decode(status: Int, operationID: String, body: Data) -> CubbyAPIError {
        struct Envelope: Decodable {
            let ok: Bool
            let error: ErrorDetail
        }

        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: body),
            envelope.ok == false
        else {
            return CubbyAPIError(status: status, operationID: operationID, detail: nil)
        }
        return CubbyAPIError(status: status, operationID: operationID, detail: envelope.error)
    }
}
