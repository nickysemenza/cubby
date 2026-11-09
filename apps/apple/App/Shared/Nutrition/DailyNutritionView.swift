import CubbyKit
import SwiftUI

struct DailyNutritionView: View {
    var previewSummary: MealNutritionOut?

    @Environment(AppModel.self) private var appModel
    @State private var selectedDay: String
    @State private var nutrition: MealNutritionModel?
    @State private var choosingDate = false

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
        // The day is the title; stepping and choosing it live in the toolbar.
        .navigationTitle(displayDate)
        .navigationSubtitle(HouseholdDay.isFuture(selectedDay) ? "Planned nutrition" : "Nutrition")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar { dayControls }
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
            if let refreshError {
                InlineLoadFailure(message: refreshError, isRetrying: isLoading, retry: onRefresh)
            }
            switch state {
            case .loading:
                LoadingIndicator(label: "Loading nutrition")
            case .failed(let message):
                InlineLoadFailure(message: message, isRetrying: isLoading, retry: onRefresh)
            case .loaded(let summary):
                MealNutritionPeopleView(summary: summary, showMealHeadings: true, layout: .sections)
            }
        }
        .refreshControl(onRefresh)
        .accessibilityIdentifier("nutrition.day")
    }

    /// Previous and next day (⌘← and ⌘→), Today, and a calendar for any other day.
    @ToolbarContentBuilder private var dayControls: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            Button("Previous day", systemImage: "chevron.backward") { moveDay(by: -1) }
                .keyboardShortcut(.leftArrow, modifiers: .command)
            Button("Choose date", systemImage: "calendar") { choosingDate = true }
                .popover(isPresented: $choosingDate) {
                    VStack(alignment: .leading, spacing: FieldGuideTokens.Space.md) {
                        DatePicker("Date", selection: selectedDate, displayedComponents: .date)
                            .datePickerStyle(.graphical)
                            .labelsHidden()
                            .environment(\.timeZone, HouseholdDay.timeZone)
                        Button("Today") {
                            selectedDay = HouseholdDay.string(for: .now)
                            choosingDate = false
                        }
                        .disabled(isToday)
                    }
                    .padding(FieldGuideTokens.Space.lg)
                    .frame(minWidth: 300)
                    .presentationCompactAdaptation(.popover)
                }
            Button("Next day", systemImage: "chevron.forward") { moveDay(by: 1) }
                .keyboardShortcut(.rightArrow, modifiers: .command)
        }
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
