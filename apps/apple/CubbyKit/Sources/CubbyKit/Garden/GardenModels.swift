import Foundation

/// The lifecycle deliberately describes the garden record, rather than a harvest cycle: herbs
/// and trees can stay growing through many entries.
public enum GardenPlantingStatus: String, CaseIterable, Codable, Sendable, Hashable {
    case planned
    case growing
    case finished
}

public enum GardenEntryKind: String, CaseIterable, Codable, Sendable, Hashable {
    case observation
    case harvest
    case move
}

public enum GardenStartMethod: String, CaseIterable, Codable, Sendable, Hashable {
    case sow
    case transplant
    case existing
}

/// Garden classification adds growing context to an ordinary household location without changing
/// its existing location type or hierarchy.
public enum GardenLocationKind: String, CaseIterable, Codable, Sendable, Hashable {
    case bed
    case tray
    case other
}

public enum GardenLocationStartKind: String, CaseIterable, Codable, Sendable, Hashable {
    case actual
    case recorded
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

public struct GardenGuideWindow: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let sourceID: String
    public let microclimate: String?
    public let method: String
    public let months: [Int]
    public let monthPart: String?
    public let note: String?

    public init(
        id: String,
        sourceID: String,
        microclimate: String? = nil,
        method: String,
        months: [Int],
        monthPart: String? = nil,
        note: String? = nil
    ) {
        self.id = id
        self.sourceID = sourceID
        self.microclimate = microclimate
        self.method = method
        self.months = months
        self.monthPart = monthPart
        self.note = note
    }
}

public struct GardenGuide: Codable, Sendable, Hashable {
    public let key: String
    public let name: String
    public let aliases: [String]
    public let windows: [GardenGuideWindow]
    public let notes: String?

    public init(
        key: String,
        name: String,
        aliases: [String] = [],
        windows: [GardenGuideWindow],
        notes: String? = nil
    ) {
        self.key = key
        self.name = name
        self.aliases = aliases
        self.windows = windows
        self.notes = notes
    }
}

public struct GardenGuideSource: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let url: URL
    public let publishedOrRevised: String?
    public let reviewedAt: String
    public let basedOn: [String]
    public let notes: String?

    public init(
        id: String,
        name: String,
        url: URL,
        publishedOrRevised: String? = nil,
        reviewedAt: String,
        basedOn: [String] = [],
        notes: String? = nil
    ) {
        self.id = id
        self.name = name
        self.url = url
        self.publishedOrRevised = publishedOrRevised
        self.reviewedAt = reviewedAt
        self.basedOn = basedOn
        self.notes = notes
    }
}

public struct GardenGuidesDocument: Codable, Sendable, Hashable {
    public let schemaVersion: Int
    public let sources: [GardenGuideSource]
    public let guides: [GardenGuide]

    public init(schemaVersion: Int, sources: [GardenGuideSource], guides: [GardenGuide]) {
        self.schemaVersion = schemaVersion
        self.sources = sources
        self.guides = guides
    }
}

public struct GardenPlanting: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let ingredient: GardenOption
    public let product: GardenOption?
    public let location: GardenOption?
    public let intendedLocation: GardenOption?
    public let parentPlantingID: String?
    public let status: GardenPlantingStatus
    public let variety: String?
    public let quantity: String?
    public let notes: String?
    public let plannedWindow: String?
    public let plannedDate: Date?
    public let sownAt: Date?
    public let transplantedAt: Date?
    public let inLocationSince: Date?
    public let inLocationSinceKind: GardenLocationStartKind
    public let finishedAt: Date?
    public let gardenGuideKey: String?

    public init(
        id: String,
        ingredient: GardenOption,
        product: GardenOption? = nil,
        location: GardenOption? = nil,
        intendedLocation: GardenOption? = nil,
        parentPlantingID: String? = nil,
        status: GardenPlantingStatus,
        variety: String? = nil,
        quantity: String? = nil,
        notes: String? = nil,
        plannedWindow: String? = nil,
        plannedDate: Date? = nil,
        sownAt: Date? = nil,
        transplantedAt: Date? = nil,
        inLocationSince: Date? = nil,
        inLocationSinceKind: GardenLocationStartKind = .actual,
        finishedAt: Date? = nil,
        gardenGuideKey: String? = nil
    ) {
        self.id = id
        self.ingredient = ingredient
        self.product = product
        self.location = location
        self.intendedLocation = intendedLocation
        self.parentPlantingID = parentPlantingID
        self.status = status
        self.variety = variety
        self.quantity = quantity
        self.notes = notes
        self.plannedWindow = plannedWindow
        self.plannedDate = plannedDate
        self.sownAt = sownAt
        self.transplantedAt = transplantedAt
        self.inLocationSince = inLocationSince
        self.inLocationSinceKind = inLocationSinceKind
        self.finishedAt = finishedAt
        self.gardenGuideKey = gardenGuideKey
    }
}

public struct GardenLocation: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let gardenKind: String?
    public let conditions: String?
    public let plantings: [GardenPlanting]

    public init(
        id: String,
        name: String,
        gardenKind: String? = nil,
        conditions: String? = nil,
        plantings: [GardenPlanting]
    ) {
        self.id = id
        self.name = name
        self.gardenKind = gardenKind
        self.conditions = conditions
        self.plantings = plantings
    }
}

public struct GardenEntry: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let locationID: String
    public let plantingID: String?
    public let kind: GardenEntryKind
    public let observedAt: Date
    public let note: String?
    public let harvestAmount: String?
    public let locationName: String?
    public let plantingName: String?
    /// Retain the server image reference so journals can render the actual photo and link through
    /// to its ordinary Image detail record; ids alone made the correction UI a blind checklist.
    public let images: [GardenImage]

    public init(
        id: String, locationID: String, plantingID: String?, kind: GardenEntryKind, observedAt: Date,
        note: String?, harvestAmount: String?, images: [GardenImage], locationName: String? = nil,
        plantingName: String? = nil
    ) {
        self.id = id; self.locationID = locationID; self.plantingID = plantingID; self.kind = kind
        self.observedAt = observedAt; self.note = note; self.harvestAmount = harvestAmount
        self.locationName = locationName; self.plantingName = plantingName; self.images = images
    }
}

public struct GardenImage: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let url: URL
    public let filename: String
    public init(id: String, url: URL, filename: String) {
        self.id = id; self.url = url; self.filename = filename
    }
}

public enum GardenJournalContext: String, Codable, Sendable, Hashable { case direct, bed }

public struct GardenJournalEntry: Identifiable, Codable, Sendable, Hashable {
    public let entry: GardenEntry
    public let context: GardenJournalContext
    public let locationName: String
    public let plantingName: String?
    public var id: String { entry.id }

    public init(
        entry: GardenEntry, context: GardenJournalContext, locationName: String, plantingName: String?
    ) {
        self.entry = entry
        self.context = context
        self.locationName = locationName
        self.plantingName = plantingName
    }
}

public struct GardenLocationPeriod: Identifiable, Codable, Sendable, Hashable {
    public let sequence: Int; public let location: GardenOption; public var inLocationSince: Date
    public var endedOn: Date?; public let startKind: GardenLocationStartKind
    public var id: Int { sequence }
    public init(
        sequence: Int, location: GardenOption, inLocationSince: Date, endedOn: Date?,
        startKind: GardenLocationStartKind
    ) {
        self.sequence = sequence; self.location = location; self.inLocationSince = inLocationSince;
        self.endedOn = endedOn; self.startKind = startKind
    }
}

public struct EditGardenEntry: Sendable, Hashable {
    public let id: String; public let locationID: String; public let plantingID: String?
    public let kind: GardenEntryKind; public let observedAt: Date; public let note: String?
    public let harvestAmount: String?; public let pendingImageIDs: [ImageCode];
    public let removeImageIDs: [String]
    public init(
        id: String, locationID: String, plantingID: String?, kind: GardenEntryKind, observedAt: Date,
        note: String?, harvestAmount: String?, pendingImageIDs: [ImageCode], removeImageIDs: [String]
    ) {
        self.id = id; self.locationID = locationID; self.plantingID = plantingID; self.kind = kind
        self.observedAt = observedAt; self.note = note; self.harvestAmount = harvestAmount
        self.pendingImageIDs = pendingImageIDs; self.removeImageIDs = removeImageIDs
    }
}

public struct EditGardenPlanting: Sendable, Hashable {
    public let id: String; public let ingredientID: String; public let productID: String?
    public let intendedLocationID: String?; public let variety: String?; public let quantity: String?
    public let notes: String?; public let plannedWindow: String?; public let plannedDate: Date?
    public let sownAt: Date?; public let transplantedAt: Date?
    public init(
        id: String, ingredientID: String, productID: String?, intendedLocationID: String?, variety: String?,
        quantity: String?, notes: String?, plannedWindow: String?, plannedDate: Date?, sownAt: Date?,
        transplantedAt: Date?
    ) {
        self.id = id; self.ingredientID = ingredientID; self.productID = productID;
        self.intendedLocationID = intendedLocationID
        self.variety = variety; self.quantity = quantity; self.notes = notes;
        self.plannedWindow = plannedWindow
        self.plannedDate = plannedDate; self.sownAt = sownAt; self.transplantedAt = transplantedAt
    }
}

public struct GardenOverview: Codable, Sendable, Hashable {
    public let locations: [GardenLocation]
    public let finishedPlantings: [GardenPlanting]
    public let unassignedPlantings: [GardenPlanting]

    public init(
        locations: [GardenLocation],
        finishedPlantings: [GardenPlanting],
        unassignedPlantings: [GardenPlanting] = []
    ) {
        self.locations = locations
        self.finishedPlantings = finishedPlantings
        self.unassignedPlantings = unassignedPlantings
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
}

public struct CreateGardenPlanting: Codable, Sendable, Hashable {
    public let ingredientID: String
    public let locationID: String?
    public let intendedLocationID: String?
    public let productID: String?
    public let status: GardenPlantingStatus
    public let variety: String?
    public let quantity: String?
    public let notes: String?
    public let plannedWindow: String?
    public let plannedDate: Date?
    public let sownAt: Date?
    public let transplantedAt: Date?
    public let inLocationSince: Date?
    public let inLocationSinceKind: GardenLocationStartKind

    public init(
        ingredientID: String,
        locationID: String? = nil,
        intendedLocationID: String? = nil,
        productID: String? = nil,
        status: GardenPlantingStatus,
        variety: String? = nil,
        quantity: String? = nil,
        notes: String? = nil,
        plannedWindow: String? = nil,
        plannedDate: Date? = nil,
        sownAt: Date? = nil,
        transplantedAt: Date? = nil,
        inLocationSince: Date? = nil,
        inLocationSinceKind: GardenLocationStartKind = .actual
    ) {
        self.ingredientID = ingredientID
        self.locationID = locationID
        self.intendedLocationID = intendedLocationID
        self.productID = productID
        self.status = status
        self.variety = variety
        self.quantity = quantity
        self.notes = notes
        self.plannedWindow = plannedWindow
        self.plannedDate = plannedDate
        self.sownAt = sownAt
        self.transplantedAt = transplantedAt
        self.inLocationSince = inLocationSince
        self.inLocationSinceKind = inLocationSinceKind
    }
}

public struct RecordGardenEntry: Codable, Sendable, Hashable {
    public let locationID: String
    public let plantingID: String?
    public let kind: GardenEntryKind
    public let observedAt: Date
    public let note: String?
    public let harvestAmount: String?
    public let pendingImageIDs: [ImageCode]

    public init(
        locationID: String,
        plantingID: String? = nil,
        kind: GardenEntryKind,
        observedAt: Date,
        note: String? = nil,
        harvestAmount: String? = nil,
        pendingImageIDs: [ImageCode] = []
    ) {
        self.locationID = locationID
        self.plantingID = plantingID
        self.kind = kind
        self.observedAt = observedAt
        self.note = note
        self.harvestAmount = harvestAmount
        self.pendingImageIDs = pendingImageIDs
    }
}

public struct MoveGardenPlanting: Codable, Sendable, Hashable {
    public let plantingID: String
    public let destinationLocationID: String
    public let observedAt: Date
    public let note: String?

    public init(plantingID: String, destinationLocationID: String, observedAt: Date, note: String? = nil) {
        self.plantingID = plantingID
        self.destinationLocationID = destinationLocationID
        self.observedAt = observedAt
        self.note = note
    }
}

public struct SplitGardenPlanting: Codable, Sendable, Hashable {
    public let plantingID: String
    public let destinationLocationID: String
    public let quantity: String?
    public let observedAt: Date
    public let note: String?

    public init(
        plantingID: String,
        destinationLocationID: String,
        quantity: String? = nil,
        observedAt: Date,
        note: String? = nil
    ) {
        self.plantingID = plantingID
        self.destinationLocationID = destinationLocationID
        self.quantity = quantity
        self.observedAt = observedAt
        self.note = note
    }
}
