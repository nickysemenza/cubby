import Charts
import CubbyKit
import SwiftUI

enum DetailActivityDate {
    static func day(for date: Date, allDay: Bool) -> String {
        guard allDay else { return HouseholdDay.string(for: date) }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withFullDate]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }
}

struct MonthlyExpenseSpendChart: View {
    let points: MonthlyExpenseSpendOutput

    private var totalCents: Int { points.reduce(0) { $0 + $1.cents } }
    private var minimum: Int { min(0, points.map(\.cents).min() ?? 0) }
    private var maximum: Int { max(0, points.map(\.cents).max() ?? 0) }

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            HStack(alignment: .firstTextBaseline) {
                Text("Spend, last 12 months")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Spacer()
                Text(ValueFormat.currency(Double(totalCents) / 100))
                    .font(.fieldGuideData.weight(.semibold))
                    .monospacedDigit()
            }
            Chart {
                RuleMark(y: .value("Zero", 0))
                    .foregroundStyle(.secondary.opacity(0.35))
                    .lineStyle(StrokeStyle(lineWidth: 1))
                ForEach(points, id: \.month) { point in
                    BarMark(
                        x: .value("Month", point.month),
                        yStart: .value("Zero", min(0, point.cents)),
                        yEnd: .value("Spend", max(0, point.cents))
                    )
                    .foregroundStyle(
                        point.cents < 0
                            ? FieldGuideTokens.graphiteSecondary.opacity(0.55)
                            : FieldGuideTokens.interaction
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 2))
                }
            }
            .chartYScale(domain: Double(minimum)...Double(maximum == minimum ? maximum + 1 : maximum))
            .chartYAxis(.hidden)
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 6)) { value in
                    AxisValueLabel {
                        if let month = value.as(String.self) {
                            Text(monthLabel(month))
                        }
                    }
                }
            }
            .frame(height: 96)
            .accessibilityLabel("Monthly expense spend for the last 12 months")
            .accessibilityValue(ValueFormat.currency(Double(totalCents) / 100))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, FieldGuideTokens.Space.sm)
    }

    private func monthLabel(_ value: String) -> String {
        let formatter = DateFormatter()
        formatter.locale = .autoupdatingCurrent
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = HouseholdDay.timeZone
        formatter.setLocalizedDateFormatFromTemplate("LLL")
        guard let date = HouseholdDay.date(from: "\(value)-01") else { return value }
        return formatter.string(from: date)
    }
}

struct DetailActivitySection: View {
    let events: [DetailActivityEvent]
    let isLoadingMore: Bool
    let hasMore: Bool
    let onLoadMore: () -> Void

    private var groups: [(day: String, events: [DetailActivityEvent])] {
        var result: [(day: String, events: [DetailActivityEvent])] = []
        for event in events {
            let day = activityDay(event)
            if result.last?.day == day {
                result[result.count - 1].events.append(event)
            } else {
                result.append((day, [event]))
            }
        }
        return result
    }

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.md) {
            Text("Activity")
                .font(.headline)
            if events.isEmpty {
                Text("No activity yet.").foregroundStyle(.secondary)
            } else {
                ForEach(groups, id: \.day) { group in
                    VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                        Text(DatePresentation.plainDate(group.day)?.absolute ?? group.day)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                        ForEach(group.events, id: \.id) { event in
                            activityRow(event)
                        }
                    }
                }
            }
            if hasMore {
                Button(isLoadingMore ? "Loading…" : "Show older") { onLoadMore() }
                    .disabled(isLoadingMore)
                    .frame(minHeight: FieldGuideTokens.touchTarget, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func activityDay(_ event: DetailActivityEvent) -> String {
        DetailActivityDate.day(for: event.date, allDay: event.allDay)
    }

    @ViewBuilder
    private func activityRow(_ event: DetailActivityEvent) -> some View {
        let isRecord = event.kind.rawValue == "record"
        let entity = EntityCatalog[event.entity]
        let destination = isRecord ? event.shortcode.map { Route.entityDetail(event.entity, id: $0) } : nil
        let title = isRecord ? event.title : changeVerb(event.title)
        let subtitle = isRecord ? event.subtitle : changedFieldLabels(event)
        RecordListRow(
            title: title,
            titleDestination: destination,
            symbol: entity.sfSymbol,
            thumbnailSize: 22
        ) {
            if isRecord, let shortcode = event.shortcode {
                Text("\(entity.singular) · \(shortcode)")
            } else if let subtitle {
                Text(subtitle)
            } else {
                Text(entity.singular)
            }
        } rail: {
            if let cents = event.amountCents {
                Text(ValueFormat.currency(Double(cents) / 100))
                    .font(.fieldGuideData)
            } else if !event.allDay {
                Text(DatePresentation.timestamp(event.date).absolute)
                    .monospacedDigit()
            }
        } supplement: {
            EmptyView()
        }
    }

    private func changeVerb(_ action: String) -> String {
        switch action {
        case "create": "Created"
        case "update": "Updated"
        case "delete": "Deleted"
        default: action.capitalized
        }
    }

    private func changedFieldLabels(_ event: DetailActivityEvent) -> String? {
        event.subtitle?.split(separator: ", ").map { key in
            EntityCatalog[event.entity].field(String(key))?.label ?? String(key)
        }.joined(separator: ", ")
    }
}
