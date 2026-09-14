import Foundation

extension PresignedUpload {
    public typealias FilePut =
        @Sendable (_ fileURL: URL, _ url: URL, _ contentType: String) async throws -> Void

    public static func putFile(
        _ fileURL: URL,
        to url: URL,
        contentType: String,
        session: URLSession = .cubbyShared
    ) async throws {
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        let (body, response) = try await session.upload(for: request, fromFile: fileURL)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw CubbyAPIError.decode(status: status, operationID: "presigned.put", body: body)
        }
    }
}
