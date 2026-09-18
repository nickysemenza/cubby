import CubbyKit
import SwiftUI

struct DailyNutritionView: View {
    var previewSummary: MealNutritionOut?

    @Environment(AppModel.self) private var appModel
    @State private var selectedDay: String
    @State private var nutrition: MealNutritionModel?

    init(day: String, previewSummary: MealNutritionOut? = nil) {
        self.previewSummary = previewSummary
        // Reached only via `.navigationDestination(for: Route.self)` (`Route.nutrition(day)`);
        // each distinct `day` is a separate path entry, never reused in place for another `day`.
        _selectedDay = State(initialValue: day)  // state-init-ok
    }

    var body: some View {
        Group {
            if let previewSummary {
                content(state: .loaded(previewSummary), isLoading: false, refreshError: nil, onRefresh: {})
            } else if let nutrition {
                content(
                    state: nutrition.state, isLoading: nutrition.isLoading,
                    refreshError: nutrition.refreshError, onRefresh: { await nutrition.refresh() })
            } else {
                LoadingIndicator.screen(label: "Loading nutrition")
            }
        }
        .navigationTitle("Nutrition")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .task(id: selectedDay) {
            guard previewSummary == nil else { return }
            nutrition = nil
            let nutrition = MealNutritionModel(query: .day(selectedDay), client: appModel.client)
            self.nutrition = nutrition
            await nutrition.refresh()
        }
    }

    private func content(
        state: TodaySectionState<MealNutritionOut>, isLoading: Bool, refreshError: String?,
        onRefresh: @escaping @Sendable () async -> Void
    ) -> some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
                    Text(displayDate).font(.porcelainHeadline)
                    if HouseholdDay.isFuture(selectedDay) {
                        Label("Planned", systemImage: "calendar.badge.clock")
                            .font(.porcelainLabel)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, PorcelainTokens.Space.xs)
                DatePicker("Date", selection: selectedDate, displayedComponents: .date)
                    .environment(\.timeZone, HouseholdDay.timeZone)
                HStack(spacing: PorcelainTokens.Space.sm) {
                    Button("Previous day", systemImage: "chevron.left") { moveDay(by: -1) }
                        .labelStyle(.iconOnly)
                        .accessibilityLabel("Previous day")
                    Spacer()
                    Button("Today") { selectedDay = HouseholdDay.string(for: .now) }
                        .disabled(isToday)
                    Spacer()
                    Button("Next day", systemImage: "chevron.right") { moveDay(by: 1) }
                        .labelStyle(.iconOnly)
                        .accessibilityLabel("Next day")
                }
                .buttonStyle(.borderless)
                .frame(minHeight: PorcelainTokens.touchTarget)
            }
            Section("Per person") {
                switch state {
                case .loading:
                    LoadingIndicator(label: "Loading nutrition")
                case .failed(let message):
                    failure(message, isLoading: isLoading, retry: onRefresh)
                case .loaded(let summary):
                    MealNutritionPeopleView(summary: summary, showMealHeadings: true)
                }
                if let refreshError {
                    failure(refreshError, isLoading: isLoading, retry: onRefresh)
                }
            }
        }
        .refreshControl(onRefresh)
        .accessibilityIdentifier("nutrition.day")
    }

    private var displayDate: String {
        HouseholdDay.date(from: selectedDay)?.formatted(
            Date.FormatStyle(date: .omitted, time: .omitted, timeZone: HouseholdDay.timeZone)
                .weekday(.wide).month(.wide).day()) ?? selectedDay
    }

    private var selectedDate: Binding<Date> {
        Binding(
            get: { HouseholdDay.date(from: selectedDay) ?? .now },
            set: { selectedDay = HouseholdDay.string(for: $0) })
    }

    private var isToday: Bool {
        selectedDay == HouseholdDay.string(for: .now)
    }

    private func moveDay(by value: Int) {
        guard let date = HouseholdDay.date(from: selectedDay) else { return }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = HouseholdDay.timeZone
        guard let moved = calendar.date(byAdding: .day, value: value, to: date) else { return }
        selectedDay = HouseholdDay.string(for: moved)
    }

    private func failure(
        _ message: String, isLoading: Bool, retry: @escaping @Sendable () async -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            Text(message).font(.callout).foregroundStyle(.secondary)
            if isLoading { LoadingIndicator(label: "Retrying") }
            Button("Retry") { Task { await retry() } }.disabled(isLoading)
        }
    }
}

#Preview("Daily nutrition") {
    NavigationStack {
        DailyNutritionView(day: "2026-09-14", previewSummary: PreviewFixtures.sampleMealNutrition)
    }
    .environment(PreviewFixtures.signedInModel())
}

#Preview("Planned daily nutrition") {
    NavigationStack {
        DailyNutritionView(day: "2099-09-14", previewSummary: PreviewFixtures.sampleMealNutrition)
    }
    .environment(PreviewFixtures.signedInModel())
}
