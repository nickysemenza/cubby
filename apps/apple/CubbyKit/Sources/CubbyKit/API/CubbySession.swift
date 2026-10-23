import Foundation

extension URLSession {
    /// One session for every Cubby request. Ambient cookie storage stays disabled so bearer auth
    /// cannot silently become a cookie session; the native request headers send only Better Auth's
    /// signed session-data cache cookie beside the bearer credential.
    public static let cubbyShared: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .useProtocolCachePolicy
        return URLSession(configuration: configuration)
    }()
}
