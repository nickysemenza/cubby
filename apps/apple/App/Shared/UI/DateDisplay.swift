import CubbyKit
import SwiftUI

/// One date surface for full dates and compact tables; exact seconds and zone remain in help.
public struct DateDisplay: View {
    let value: String
    var compact = false
    var stacked = false

    public init(_ value: String, compact: Bool = false, stacked: Bool = false) {
        self.value = value
        self.compact = compact
        self.stacked = stacked
    }

    public init(date: Date, compact: Bool = false, stacked: Bool = false) {
        self.init(date.ISO8601Format(), compact: compact, stacked: stacked)
    }

    public var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            if let display = DatePresentation.value(value, now: context.date, compact: compact) {
                Group {
                    if stacked {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(display.absolute)
                            Text(display.relative).foregroundStyle(.secondary)
                        }
                    } else {
                        Text(
                            "\(display.absolute)\(Text(" · \(display.relative)").foregroundStyle(.secondary))"
                        )
                    }
                }
                .monospacedDigit()
                .help(display.exact)
                .accessibilityLabel(display.text)
            } else {
                Text(value)
            }
        }
    }
}

#Preview("Date display") {
    VStack(alignment: .leading) {
        DateDisplay(date: .now.addingTimeInterval(-120))
        DateDisplay("2026-10-13")
        DateDisplay(date: .now.addingTimeInterval(180), compact: true, stacked: true)
    }.padding()
}
