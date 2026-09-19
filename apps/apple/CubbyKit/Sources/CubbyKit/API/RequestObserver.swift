import Foundation

/// A hook the app installs on `CubbyClient` to observe request timing without CubbyKit depending
/// on any App type (developer overlays' request-timing strip, PR C layer 6). `CubbyAuthMiddleware`
/// is the one place every request passes through, so it is the only place this fires from — both
/// on success and on a decoded `CubbyAPIError`, since the status is known either way.
public protocol RequestObserver: Sendable {
    func record(operationID: String, ms: Double, status: Int) async
}
