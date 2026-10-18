import CubbyKit
import SwiftUI

/// One date surface for full dates and compact tables; exact seconds and zone remain in help.
public struct DateDisplay: View {
    let value: String
    /// An instant needs no parse on each minute's re-render.
    private let date: Date?
    var compact = false
    var stacked = false

    public init(_ value: String, compact: Bool = false, stacked: Bool = false) {
        self.value = value
        self.date = nil
        self.compact = compact
        self.stacked = stacked
    }

    public init(date: Date, compact: Bool = false, stacked: Bool = false) {
        self.value = date.ISO8601Format()
        self.date = date
        self.compact = compact
        self.stacked = stacked
    }

    public var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            if let display = date.map({ DatePresentation.timestamp($0, now: context.date, compact: compact) })
                ?? DatePresentation.value(value, now: context.date, compact: compact)
            {
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
