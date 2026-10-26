import CubbyKit
import Foundation
import Observation
import SwiftUI

/// The load/phase seam every specialist layout (calendar, board, gallery) shares:
/// the manifest names the layout id, the layout supplies only its fetch and its rows.
@MainActor @Observable
private final class SpecialistLoader<Value> {
    enum Phase {
        case loading
        case ready(Value)
        case failed(String)
    }

    private(set) var phase: Phase = .loading
    private var filters = EntityFilterState()
    private var fetch: (@MainActor (EntityFilterState) async throws -> Value)?

    func load(
        filters: EntityFilterState, fetch: @escaping @MainActor (EntityFilterState) async throws -> Value
    ) async {
        self.filters = filters
        self.fetch = fetch
        phase = .loading
        do {
            phase = .ready(try await fetch(filters))
        } catch {
            Diagnostics.report(error, context: "Load specialist view")
            phase = .failed(error.userMessage)
        }
    }

    func reload() async {
        guard let fetch else { return }
        await load(filters: filters, fetch: fetch)
    }

    /// Runs a mutation, then re-fetches; a failure replaces the screen with the raw error.
    func perform(_ action: @MainActor () async throws -> Void) async {
        do {
            try await action()
            await reload()
        } catch {
            Diagnostics.report(error, context: "Update specialist view")
            phase = .failed(error.userMessage)
        }
    }
}

/// The declared list slots native draws: one case per slot `packages/schemas/src/native-coverage.ts`
/// marks `implemented`, so the compiler holds the two together.
enum ListSlotRegistry {
    @MainActor
    static func view(
        _ slot: ImplementedListSlotID, client: CubbyClient, filters: EntityFilterState
    ) -> AnyView {
        switch slot {
        case .mealCalendar: AnyView(MealCalendarListView(client: client, filters: filters))
        case .locationGallery: AnyView(LocationGalleryListView(client: client, filters: filters))
        }
    }
}

private struct SpecialistLoadView<Value, Content: View>: View {
    private struct ReloadKey: Hashable {
        let filters: EntityFilterState
        let extra: AnyHashable
    }

    let loadingLabel: String
    let filters: EntityFilterState
    var reloadKey: AnyHashable = 0
    let fetch: @MainActor (EntityFilterState) async throws -> Value
    @ViewBuilder let content: (Value, SpecialistLoader<Value>) -> Content
    @State private var loader = SpecialistLoader<Value>()

    var body: some View {
        Group {
            switch loader.phase {
            case .loading:
                LoadingIndicator.screen(label: loadingLabel)
            case .failed(let message):
                LoadFailureView(title: "Couldn't load view", message: message) { await loader.reload() }
            case .ready(let value):
                content(value, loader)
            }
        }
        .task(id: ReloadKey(filters: filters, extra: reloadKey)) {
            await loader.load(filters: filters, fetch: fetch)
        }
        .refreshControl { await loader.reload() }
    }
}

private func wire(_ value: some Encodable) -> JSONValue {
    (try? JSONValue(encoding: value)) ?? .null
}

private func isoDay(_ date: Date) -> String {
    PlainDate(date).rawValue
}

private extension Array where Element: Hashable {
    func uniqued() -> [Element] {
        Array(Set(self)).sorted { String(describing: $0) < String(describing: $1) }
    }
}

// MARK: - meal.calendar

/// A month of meals. `dayItemIDs` is the server's `days[day].itemIds` (which items cover each
/// day), narrowed to the filtered set — the client never compares spans itself.
private struct MealCalendarData {
    let items: [JSONValue]
    let dayItemIDs: [String: [String]]

    func meals(on day: String) -> [JSONValue] {
        let ids = Set(dayItemIDs[day] ?? [])
        return items.filter { $0["id"]?.stringValue.map(ids.contains) ?? false }
    }
}

struct MealCalendarListView: View {
    let client: CubbyClient
    let filters: EntityFilterState
    @State private var month =
        Calendar.current.date(from: Calendar.current.dateComponents([.year, .month], from: .now)) ?? .now
    @State private var selectedDay = 1

    var body: some View {
        let month = month
        SpecialistLoadView(
            loadingLabel: "Loading calendar", filters: filters, reloadKey: month,
            fetch: { filters in try await Self.meals(client: client, month: month, filters: filters) }
        ) { data, _ in
            ScrollView {
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.lg) {
                    monthGrid(data)
                    Panel {
                        Text("\(selectedDay) \(month.formatted(.dateTime.month(.wide)))")
                            .font(.fieldGuideTitle)
                        let meals = data.meals(on: dayKey(selectedDay))
                        if meals.isEmpty {
                            Text("No meals planned").foregroundStyle(.secondary)
                        }
                        ForEach(meals.indices, id: \.self) { index in
                            let item = meals[index]
                            if let id = item["id"]?.stringValue {
                                NavigationLink(value: Route.entityDetail(.meal, id: id)) {
                                    HStack {
                                        VStack(alignment: .leading) {
                                            Text(item["title"]?.stringValue ?? "Meal")
                                            EntityQualityFact(key: .meal, id: id, raw: item)
                                        }
                                        Spacer()
                                        Image(systemName: "chevron.right")
                                    }
                                }
                            }
                        }
                    }
                }
                .padding(FieldGuideTokens.Space.lg)
            }
        }
        .onChange(of: month) { selectedDay = 1 }
    }

    private static func meals(
        client: CubbyClient, month: Date, filters: EntityFilterState
    ) async throws -> MealCalendarData {
        let end = Calendar.current.date(byAdding: .month, value: 1, to: month) ?? month
        let response = wire(try await client.mealCalendar(from: isoDay(month), to: isoDay(end)))
        let items = response["items"]?.arrayValue ?? []
        let days = (response["days"]?.objectValue ?? [:]).mapValues {
            $0["itemIds"]?.arrayValue?.compactMap(\.stringValue) ?? []
        }
        if filters.isEmpty { return MealCalendarData(items: items, dayItemIDs: days) }
        let matched = try await client.listAllIDs(EntityCatalog[.meal], filters: filters)
        return MealCalendarData(
            items: items.filter { $0["id"]?.stringValue.map(matched.contains) ?? false },
            dayItemIDs: days.mapValues { $0.filter(matched.contains) })
    }

    private func dayKey(_ day: Int) -> String {
        isoDay(Calendar.current.date(byAdding: .day, value: day - 1, to: month) ?? month)
    }

    private func monthGrid(_ data: MealCalendarData) -> some View {
        let calendar = Calendar.current
        let count = calendar.range(of: .day, in: .month, for: month)?.count ?? 30
        let leading = (calendar.component(.weekday, from: month) - calendar.firstWeekday + 7) % 7
        let columns = Array(repeating: GridItem(.flexible()), count: 7)
        return Panel {
            HStack {
                Button("Previous month", systemImage: "chevron.left") { shift(-1) }
                    .labelStyle(.iconOnly)
                Spacer()
                Text(month.formatted(.dateTime.month(.wide).year())).font(.fieldGuideTitle)
                Spacer()
                Button("Next month", systemImage: "chevron.right") { shift(1) }
                    .labelStyle(.iconOnly)
            }
            LazyVGrid(columns: columns, spacing: FieldGuideTokens.Space.sm) {
                ForEach(0..<7, id: \.self) { offset in
                    Text(calendar.shortStandaloneWeekdaySymbols[(calendar.firstWeekday - 1 + offset) % 7])
                        .font(.caption2).foregroundStyle(.secondary)
                }
                ForEach(0..<(leading + count), id: \.self) { slot in
                    if slot < leading {
                        Color.clear.frame(height: 44)
                    } else {
                        let day = slot - leading + 1
                        let number = data.meals(on: dayKey(day)).count
                        Button {
                            selectedDay = day
                        } label: {
                            VStack(spacing: 2) {
                                Text("\(day)")
                                Text(number > 0 ? "\(number)" : " ")
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .background(
                                day == selectedDay ? FieldGuideTokens.interaction.opacity(0.15) : .clear
                            )
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(day), \(number) meals")
                    }
                }
            }
        }
    }

    private func shift(_ months: Int) {
        month = Calendar.current.date(byAdding: .month, value: months, to: month) ?? month
    }
}

// MARK: - location.gallery

struct LocationGalleryListView: View {
    let client: CubbyClient
    let filters: EntityFilterState
    @State private var type = "all"

    var body: some View {
        SpecialistLoadView(
            loadingLabel: "Loading locations", filters: filters,
            fetch: { filters in
                let tree = try await client.locationTree()
                var nodes: [LocationTreeNode] = []
                func visit(_ node: LocationTreeNode) {
                    nodes.append(node)
                    node.childNodes.forEach(visit)
                }
                tree.roots.forEach(visit)
                if filters.isEmpty { return nodes }
                let matched = try await client.listAllIDs(EntityCatalog[.location], filters: filters)
                return nodes.filter { matched.contains($0.id.rawValue) }
            }
        ) { locations, _ in
            List {
                Picker("Type", selection: $type) {
                    Text("All").tag("all")
                    ForEach(Array(Set(locations.map { $0.type.rawValue })).sorted(), id: \.self) {
                        Text($0.capitalized).tag($0)
                    }
                }
                ForEach(locations.filter { type == "all" || $0.type.rawValue == type }, id: \.id) { node in
                    NavigationLink(value: Route.entityDetail(.location, id: node.id.rawValue)) {
                        HStack {
                            let url = node.displayImages?.first.flatMap {
                                URL(string: $0.representations?.preferred ?? $0.url)
                            }
                            Thumb(url: url, size: 48, symbol: "shippingbox")
                            VStack(alignment: .leading) {
                                Text(node.name)
                                // The fact reads only `dataQuality`; encoding the whole node would re-encode its
                                // subtree and inventory once per row.
                                EntityQualityFact(
                                    key: .location, id: node.id.rawValue,
                                    raw: .object(["dataQuality": wire(node.dataQuality)]))
                                Text("\(node.totalItems) items · \(node.childNodes.count) sublocations")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
    }
}
