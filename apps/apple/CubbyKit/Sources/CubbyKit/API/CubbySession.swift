import Foundation

extension URLSession {
    /// One session for every Cubby request: default URLCache (images and lists stay warm),
    /// no cookie storage so sign-in never silently upgrades to an ambient cookie session.
    public static let cubbyShared: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .useProtocolCachePolicy
        return URLSession(configuration: configuration)
    }()
}
