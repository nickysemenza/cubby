import Foundation

public enum NativeWorkspaceSession {
    static func cookies(
        data: Data, response: HTTPURLResponse, policy: NativeWorkspacePolicy,
        headers: [String: String]? = nil
    ) throws -> [HTTPCookie] {
        guard (200..<300).contains(response.statusCode) else {
            throw NativeWorkspaceError.bootstrap(response.statusCode, String(decoding: data, as: UTF8.self))
        }
        let fields =
            headers
            ?? response.allHeaderFields.reduce(into: [String: String]()) {
                $0[String(describing: $1.key)] = String(describing: $1.value)
            }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: fields, for: policy.baseURL)
            .filter(policy.accepts)
        guard !cookies.isEmpty else { throw NativeWorkspaceError.missingCookie }
        return cookies
    }
}
