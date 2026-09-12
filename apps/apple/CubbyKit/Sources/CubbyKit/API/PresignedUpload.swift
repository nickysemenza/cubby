import Foundation

/// The one request in the app that does not go through `CubbyAuthMiddleware`: a PUT to the
/// presigned R2 URL from `image.uploadImage`. The signature covers exactly the content type
/// and length, so this sends only `Content-Type` — an `Authorization` header or a cookie would
/// break the signature, and the bytes must be exactly the size that was presigned.
public enum PresignedUpload {
    public typealias Put = @Sendable (_ data: Data, _ url: URL, _ contentType: String) async throws -> Void

    public static func put(_ data: Data, to url: URL, contentType: String, session: URLSession = .cubbyShared) async throws {
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        let (body, response) = try await session.upload(for: request, from: data)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw CubbyAPIError.decode(status: status, operationID: "presigned.put", body: body)
        }
    }
}
