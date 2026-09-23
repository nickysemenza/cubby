import ActivityKit
import SwiftUI
import WidgetKit

struct DeviceWorkWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: DeviceWorkAttributes.self) { context in
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(context.state.title).font(.headline)
                    Spacer()
                    if context.state.additionalCount > 0 {
                        Text("+\(context.state.additionalCount)").font(.caption).foregroundStyle(.secondary)
                    }
                }
                HStack {
                    Text(context.state.detail)
                    Spacer()
                    if let progress = context.state.progress {
                        Text(progress, format: .percent.precision(.fractionLength(0)))
                            .monospacedDigit()
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                if let progress = context.state.progress { ProgressView(value: progress) }
                if let remaining = context.state.estimatedRemaining {
                    Text("\(remaining) left").font(.caption2).foregroundStyle(.secondary)
                }
            }
            .padding()
            .widgetURL(URL(string: "cubby://activity/local/\(context.state.localActivityID)"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text(context.state.title).font(.headline)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if let progress = context.state.progress {
                        Text(progress, format: .percent.precision(.fractionLength(0)))
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading) {
                        Text(context.state.detail).font(.caption)
                        if let progress = context.state.progress { ProgressView(value: progress) }
                        if let remaining = context.state.estimatedRemaining {
                            Text("\(remaining) left").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            } compactLeading: {
                Image(systemName: "shippingbox")
            } compactTrailing: {
                if let progress = context.state.progress {
                    Text(progress, format: .percent.precision(.fractionLength(0)))
                } else {
                    ProgressView()
                }
            } minimal: {
                Image(systemName: "shippingbox")
            }
            .widgetURL(URL(string: "cubby://activity/local/\(context.state.localActivityID)"))
        }
    }
}

@main
struct CubbyLiveActivityBundle: WidgetBundle {
    var body: some Widget { DeviceWorkWidget() }
}
