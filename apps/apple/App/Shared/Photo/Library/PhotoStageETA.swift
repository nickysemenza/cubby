import Foundation

/// Time-remaining estimates for the Photos header's running stages, from the rate each stage's
/// count has actually moved over the last minute. A rolling window (rather than the whole run)
/// lets the estimate follow a stage whose speed changes — the match scan's cached-fingerprint
/// chunks finish far faster than the photos it has to fingerprint afterwards.
struct PhotoStageETA {
    private struct Sample {
        let at: Date
        let count: Double
    }

    static let window: TimeInterval = 60
    /// Below this much observed time, a rate is too noisy to show.
    static let minimumSpan: TimeInterval = 2

    private var samples: [String: [Sample]] = [:]
    private var totals: [String: Int] = [:]

    mutating func record(_ stages: [PhotoLibraryStages.Stage], at now: Date) {
        for stage in stages {
            guard case .running = stage.state, let count = stage.count, stage.total != nil else {
                samples[stage.id] = nil
                totals[stage.id] = nil
                continue
            }
            var history = samples[stage.id] ?? []
            // A count that went backwards is a restarted run; its old rate says nothing.
            if let last = history.last, Double(count) < last.count { history = [] }
            history.append(Sample(at: now, count: Double(count)))
            // Keep the newest sample older than the window so the span never collapses to 0.
            if let firstInWindow = history.firstIndex(where: { now.timeIntervalSince($0.at) <= Self.window }),
                firstInWindow > 1
            {
                history.removeFirst(firstInWindow - 1)
            }
            samples[stage.id] = history
            totals[stage.id] = stage.total
        }
    }

    func remaining(for id: String, at now: Date) -> TimeInterval? {
        guard let history = samples[id], let first = history.first, let last = history.last,
            let total = totals[id]
        else { return nil }
        let span = last.at.timeIntervalSince(first.at)
        let progressed = last.count - first.count
        guard span >= Self.minimumSpan, progressed > 0 else { return nil }
        let rate = progressed / span
        // Time since the last sample has already elapsed toward the estimate.
        return max(0, (Double(total) - last.count) / rate - now.timeIntervalSince(last.at))
    }

    /// "~40s", "~3m", "~1h 5m".
    static func format(_ seconds: TimeInterval) -> String {
        let seconds = Int(seconds.rounded(.up))
        if seconds < 60 { return "~\(max(1, seconds))s" }
        let minutes = (seconds + 59) / 60
        if minutes < 60 { return "~\(minutes)m" }
        return minutes % 60 == 0 ? "~\(minutes / 60)h" : "~\(minutes / 60)h \(minutes % 60)m"
    }
}
