import ActivityKit
import SwiftUI
import WidgetKit

struct PhotoRunWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: PhotoRunActivityAttributes.self) { context in
            VStack(alignment: .leading, spacing: 8) {
                Label(
                    context.state.title,
                    systemImage: context.state.needsAttention ? "exclamationmark.circle" : "photo.stack"
                )
                .font(.headline)
                Text(context.state.detail).font(.caption).foregroundStyle(.secondary)
                if context.state.total > 0 {
                    ProgressView(value: Double(context.state.completed), total: Double(context.state.total))
                }
            }
            .padding()
            .widgetURL(URL(string: "cubby://activity/\(context.attributes.runId)"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Text(context.state.title).font(.headline) }
                DynamicIslandExpandedRegion(.bottom) { Text(context.state.detail).font(.caption) }
            } compactLeading: {
                Image(systemName: context.state.needsAttention ? "exclamationmark.circle" : "photo.stack")
            } compactTrailing: {
                Text("\(context.state.completed)/\(context.state.total)").monospacedDigit()
            } minimal: {
                Image(systemName: "photo.stack")
            }
            .widgetURL(URL(string: "cubby://activity/\(context.attributes.runId)"))
        }
    }
}
