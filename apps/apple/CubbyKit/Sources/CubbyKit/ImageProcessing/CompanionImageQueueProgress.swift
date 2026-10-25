import Foundation

/// One uninterrupted processing session. The first backlog response freezes the waiting
/// baseline; later responses update only the server's household-wide pace estimate.
public struct CompanionImageQueueProgress: Sendable, Equatable {
    public let id = UUID().uuidString
    public let startedAt: Date
    public internal(set) var completedCount = 0
    public private(set) var waitingAtStart: Int?
    public private(set) var etaSeconds: Int?

    init(startedAt: Date) { self.startedAt = startedAt }

    mutating func refresh(backlog: DeviceBacklogBanner) {
        if waitingAtStart == nil { waitingAtStart = max(0, backlog.waiting) }
        etaSeconds = backlog.etaSeconds
    }

    public var totalCount: Int? { waitingAtStart.map { completedCount + $0 } }

    public var progress: Double? {
        guard let totalCount else { return nil }
        return totalCount > 0 ? Double(completedCount) / Double(totalCount) : 0
    }

    public func detail(running: Int, locale: Locale = .autoupdatingCurrent) -> String {
        var detail = "\(running) running · \(completedCount) done"
        if let etaSeconds {
            detail += " · about \(DeviceBacklogBanner.eta(seconds: etaSeconds, locale: locale)) at this pace"
        }
        return detail
    }
}
