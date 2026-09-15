import Foundation

/// The garden glossary as one source of truth. `docs/terminology.md` § Garden is the spec; every
/// garden view reads copy from here instead of inlining it, so the two clients (this file and
/// `apps/web/src/app/garden/garden-strings.ts`) cannot drift from each other or from the doc.
enum GardenStrings {
    // MARK: - Growing areas (locations)

    static let growingArea = "growing area"
    static let raisedBed = "Raised bed"
    static let seedTray = "Seed tray"
    static let other = "Other"
    static let addGrowingArea = "Add growing area"
    static let editGrowingArea = "Edit growing area"
    static let growingAreaName = "Name"
    static let growingConditions = "Growing conditions"
    static let noLocationYet = "No location yet"
    static let wholeArea = "Whole area"
    static let location = "Location"
    static let currentLocation = "Current location"
    static let plannedFor = "Planned for"

    // MARK: - Plantings

    static let addPlanting = "Add planting"
    static let editPlanting = "Edit planting"
    static let growingNow = "Growing now"
    static let planned = "Planned"
    static let startPlanting = "Start planting"
    static let moveEverything = "Move everything"
    static let moveSomeSeedlings = "Move some seedlings"
    static let finishPlanting = "Finish planting"
    static let crop = "Crop"
    static let sourceProduct = "Source product"
    static let variety = "Variety"
    static let quantity = "Quantity"
    static let approximateQuantityPrompt = "Approximate, e.g. \u{22}6 plants\u{22} or \u{22}2 lb\u{22}"
    static let planningWindow = "Planning window (optional)"
    static let status = "Status"
    static let viewPlanting = "View planting"
    static let addPhotosOrLogEntry = "Add photos / Log entry"
    static let originalTrayPlanting = "Original tray planting"
    static let intendedDestination = "Intended destination"
    static let source = "Source"

    /// The verb-plus-explanation copy shown when starting a Move everything / Move some seedlings
    /// action, matching web's `plantingActionLabels`/explanation copy.
    static let moveEverythingExplanation =
        "Every seedling in this planting moves to the new location. The old location is recorded as this planting's history."
    static let moveSomeSeedlingsExplanation =
        "Some seedlings move to a new location as their own planting; the rest stay where they are."
    static let finishPlantingExplanation =
        "Finishing records the last day this planting was active. It can still be logged against afterward."
    static let startPlantingExplanation =
        "Starting records where and how this planting entered the garden."

    // MARK: - Entries / journal

    static let logEntry = "Log entry"
    static let editEntry = "Edit entry"
    static let editNote = "Edit note"
    static let save = "Save"
    static let cancel = "Cancel"
    static let note = "Note"
    static let harvest = "Harvest"
    static let move = "Move"
    static let entryKind = "Kind"
    static let about = "About"
    static let harvestAmount = "Harvest amount"
    static let notes = "Notes"
    static let notesPlaceholder = "Anything useful to remember"
    static let startedHere = "Started here"

    static func wholeAreaKind(_ kind: String) -> String { "\(wholeArea) · \(kind)" }
    static func harvestSummary(_ amount: String) -> String { "\(harvest): \(amount)" }

    // MARK: - Dates

    static let date = "Date"
    static let harvestDate = "Harvest date"
    static let sowedOn = "Sowed on"
    static let transplantedOn = "Transplanted on"
    static let plannedDate = "Planned date"
    static let inThisLocationSince = "In this location since"
    static let confirmLocationDates = "Confirm location dates"
    static let correctLocationDates = "Correct location dates"
    static let correctDatesInLocationHistoryHint =
        "Correct this date in the planting's location history so its journal stays consistent."
    static let recordedAsActual = "Actual date"
    static let recordedAsLater = "Recorded later"
    static let earlierPresenceUnknown =
        "Earlier presence is unknown. Add a date you know to include older bed photos."

    // MARK: - Journals

    static let gardenJournal = "Garden journal"
    static let journal = "Journal"
    static func areaJournal(_ areaName: String) -> String { "\(areaName) journal" }
    static let noEntriesYet = "No entries yet."
    static let loadMore = "Load more"
    static let loading = "Loading…"

    // MARK: - Guides

    static let plantingGuide = "Planting guide"
    static let viewSource = "View source"
    static let reviewed = "Reviewed"
    static let publishedOrRevised = "Published/revised"
    static let basedOn = "Based on"
    static let sourcesMayDiffer =
        "Sources may differ. Use the windows as local context; your bed's conditions still matter."

    // MARK: - Setup

    static let gardenSetup = "Garden setup"
    static let growingAreas = "Growing areas"
    static let addBedOrTray = "Add bed or tray"
    static let seedPacketsAndPlants = "Seed packets and plants"
    static let cropGuides = "Crop guides"
    static let notSet = "Not set"
    static let done = "Done"
    static let addEllipsis = "Add…"
    static let search = "Search"
    static let noMatches = "No matches"
    static let grows = "Grows"
    static let rememberSourceToggle = "Remember that this product grows this crop"
    static let productWriteBackExplanation =
        "This only records what the seed packet or purchased plant grows. It does not add edible inventory."

    // MARK: - Empty / error states

    static let noGardenLocationsYet = "No garden locations yet"
    static let noGardenLocationsDescription =
        "Set up a growing area in Garden setup, then add what is growing."
    static let couldNotLoadGarden = "Couldn't load the garden"
    static let retry = "Retry"
}
