import ActivityKit
import SwiftUI
import WidgetKit

struct DeviceWorkWidget<Attributes: DeviceWorkActivityAttributes>: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: Attributes.self) { context in
            let state = context.attributes.presentation(for: context.state)
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Label(state.title, systemImage: state.symbol).font(.headline)
                    Spacer()
                    if state.additionalCount > 0 {
                        Text("+\(state.additionalCount)").font(.caption).foregroundStyle(.secondary)
                    }
                }
                HStack {
                    Text(state.detail)
                    Spacer()
                    if let progress = state.progress {
                        Text(progress, format: .percent.precision(.fractionLength(0)))
                            .monospacedDigit()
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                if let progress = state.progress { ProgressView(value: progress) }
                if let remaining = state.estimatedRemaining {
                    Text("\(remaining) left").font(.caption2).foregroundStyle(.secondary)
                }
            }
            .padding()
            .widgetURL(state.url)
        } dynamicIsland: { context in
            let state = context.attributes.presentation(for: context.state)
            return
                DynamicIsland {
                    DynamicIslandExpandedRegion(.leading) {
                        Label(state.title, systemImage: state.symbol).font(.headline)
                    }
                    DynamicIslandExpandedRegion(.trailing) {
                        if let progress = state.progress {
                            Text(progress, format: .percent.precision(.fractionLength(0)))
                        }
                    }
                    DynamicIslandExpandedRegion(.bottom) {
                        VStack(alignment: .leading) {
                            Text(state.detail).font(.caption)
                            if let progress = state.progress { ProgressView(value: progress) }
                            if let remaining = state.estimatedRemaining {
                                Text("\(remaining) left").font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                } compactLeading: {
                    Image(systemName: state.symbol)
                        .accessibilityLabel(state.title)
                } compactTrailing: {
                    if let progress = state.progress {
                        Text(progress, format: .percent.precision(.fractionLength(0)))
                    } else if state.isRunning {
                        ProgressView()
                    }
                } minimal: {
                    Image(systemName: state.symbol)
                        .accessibilityLabel(state.title)
                }
                .widgetURL(state.url)
        }
    }
}

@main
struct CubbyLiveActivityBundle: WidgetBundle {
    var body: some Widget {
        DeviceWorkWidget<DeviceWorkAttributes>()
        DeviceWorkWidget<PhotoRunActivityAttributes>()
        CaptureControl()
    }
}
