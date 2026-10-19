import CubbyKit
import SwiftUI

/// One date surface for full dates and compact tables; exact seconds and zone remain in help.
public struct DateDisplay: View {
    let value: String
    /// An instant needs no parse on each minute's re-render.
    private let date: Date?
    var compact = false
    var stacked = false
    @Environment(\.locale) private var locale

    public init(_ value: String, compact: Bool = false, stacked: Bool = false) {
        self.value = value
        self.date = nil
        self.compact = compact
        self.stacked = stacked
    }

    public init(date: Date, compact: Bool = false, stacked: Bool = false) {
        self.value = date.ISO8601Format()
        // Whole seconds, as `value` carries: the relative age must not shift when the same
        // instant arrives as a `Date` instead of its ISO string.
        self.date = Date(timeIntervalSince1970: date.timeIntervalSince1970.rounded(.down))
        self.compact = compact
        self.stacked = stacked
    }

    public var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            if let display = date.map({
                DatePresentation.timestamp($0, now: context.date, compact: compact, locale: locale)
            }) ?? DatePresentation.value(value, now: context.date, compact: compact, locale: locale) {
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
