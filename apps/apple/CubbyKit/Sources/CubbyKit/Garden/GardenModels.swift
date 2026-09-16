import CubbyAPI
import Foundation

/// The garden's wire types are the generated ones (`GardenPlantingOut`, `GardenEntryOut`,
/// `GardenOverviewOut`, the `*Input` bodies and `PlantingUpdateData`/`GardenEntryUpdateData`
/// drafts). What lives here is the picker vocabulary the options endpoint returns under
/// positional names, and the start method the forms choose before it becomes a wire enum.

public enum GardenStartMethod: String, CaseIterable, Codable, Sendable, Hashable {
    case sow
    case transplant
    case existing
}

public struct GardenOption: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let gardenGuideKey: String?

    public init(id: String, name: String, gardenGuideKey: String? = nil) {
        self.id = id
        self.name = name
        self.gardenGuideKey = gardenGuideKey
    }
}

/// A seed packet or purchased plant can suggest its crop without ever becoming edible inventory.
public struct GardenProductOption: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let growsIngredientID: String?

    public init(id: String, name: String, growsIngredientID: String? = nil) {
        self.id = id
        self.name = name
        self.growsIngredientID = growsIngredientID
    }
}

public struct GardenOptions: Codable, Sendable, Hashable {
    public let ingredients: [GardenOption]
    public let locations: [GardenOption]
    public let products: [GardenProductOption]
    public let plantings: [GardenOption]

    public init(
        ingredients: [GardenOption], locations: [GardenOption], products: [GardenProductOption],
        plantings: [GardenOption] = []
    ) {
        self.ingredients = ingredients
        self.locations = locations
        self.products = products
        self.plantings = plantings
    }

    public init(_ out: GardenOptionsOut) {
        self.init(
            ingredients: out.ingredients.map {
                GardenOption(id: $0.id, name: $0.name, gardenGuideKey: $0.gardenGuideKey)
            },
            locations: out.locations.map { GardenOption(id: $0.id.rawValue, name: $0.name) },
            products: out.products.map {
                GardenProductOption(
                    id: $0.id.rawValue, name: $0.name, growsIngredientID: $0.growsIngredientId)
            },
            plantings: out.plantings.map {
                GardenOption(
                    id: $0.id, name: [$0.name, $0.locationName].compactMap { $0 }.joined(separator: " · "))
            }
        )
    }
}
