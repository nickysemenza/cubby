import CubbyKit
import Observation

enum MealNutritionQuery: Hashable {
    case meal(String)
    case day(String)
}

@MainActor
@Observable
final class MealNutritionModel {
    private(set) var state: TodaySectionState<MealNutritionSummary> = .loading
    private(set) var isLoading = false
    private(set) var refreshError: String?

    let query: MealNutritionQuery
    private let client: CubbyClient
    private var generation = 0
    private var request: Task<Void, Never>?

    init(query: MealNutritionQuery, client: CubbyClient) {
        self.query = query
        self.client = client
    }

    func refresh() async {
        request?.cancel()
        generation += 1
        let generation = generation
        isLoading = true
        refreshError = nil
        let retained = loadedValue
        let query = query
        let client = client
        let request = Task { [weak self] in
            do {
                let value = try await Self.fetch(query, client: client)
                try Task.checkCancellation()
                guard let self, generation == self.generation else { return }
                self.state = .loaded(value)
            } catch is CancellationError {
                // A newer refresh owns this summary.
            } catch {
                guard let self, generation == self.generation else { return }
                let message = (error as? CubbyAPIError)?.detail?.message ?? String(describing: error)
                if let retained {
                    self.state = .loaded(retained)
                    self.refreshError = message
                } else {
                    self.state = .failed(message)
                }
                Diagnostics.report(error, context: "meal.nutrition")
            }
        }
        self.request = request
        await request.value
        guard generation == self.generation else { return }
        self.request = nil
        isLoading = false
    }

    private var loadedValue: MealNutritionSummary? {
        if case .loaded(let value) = state { return value }
        return nil
    }

    private static func fetch(_ query: MealNutritionQuery, client: CubbyClient) async throws
        -> MealNutritionSummary
    {
        switch query {
        case .meal(let id): return try await client.mealNutrition(mealID: id)
        case .day(let day): return try await client.mealNutrition(on: day)
        }
    }
}
