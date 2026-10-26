import ActivityKit
import Foundation

/// Local execution and server-pushed imports share a presentation, not an execution feed.
nonisolated protocol DeviceWorkActivityAttributes: ActivityAttributes {
    func presentation(for state: ContentState) -> DeviceWorkPresentation
}

nonisolated struct DeviceWorkPresentation {
    let title: String
    let detail: String
    let symbol: String
    let progress: Double?
    var additionalCount: Int = 0
    var estimatedRemaining: String?
    var isRunning = true
    let url: URL?
}

extension DeviceWorkAttributes: DeviceWorkActivityAttributes {
    nonisolated func presentation(for state: ContentState) -> DeviceWorkPresentation {
        .init(
            title: state.title, detail: state.detail, symbol: state.symbol,
            progress: state.progress, additionalCount: state.additionalCount,
            estimatedRemaining: state.estimatedRemaining,
            isRunning: state.hasEnded != true,
            url: state.destinationURL)
    }
}

extension PhotoRunActivityAttributes: DeviceWorkActivityAttributes {
    nonisolated func presentation(for state: ContentState) -> DeviceWorkPresentation {
        .init(
            title: state.title, detail: state.detail, symbol: state.symbol,
            progress: state.total > 0 ? min(1, max(0, Double(state.completed) / Double(state.total))) : nil,
            isRunning: !state.shouldEnd,
            url: URL(string: "cubby://activity/\(runId)"))
    }
}
