import Foundation

/// The garden glossary as one source of truth. `docs/terminology.md` § Garden is the spec; every
/// garden view reads copy from here instead of inlining it, so the two clients (this file and
/// `apps/web/src/app/garden/garden-strings.ts`) cannot drift from each other or from the doc.
enum GardenStrings {
    // MARK: - Growing areas (locations)

    static let addGrowingArea = "Add growing area"
    static let noLocationYet = "No location yet"
    static let wholeArea = "Whole area"
    static let location = "Location"

    // MARK: - Plantings

    static let addPlanting = "Add planting"
    static let startPlanting = "Start planting"
    static let moveEverything = "Move everything"
    static let moveSomeSeedlings = "Move some seedlings"
    static let finishPlanting = "Finish planting"
    static let quantity = "Quantity"
    static let approximateQuantityPrompt = "Approximate, e.g. \u{22}6 plants\u{22} or \u{22}2 lb\u{22}"
    static let about = "About"

    /// The verb-plus-explanation copy shown when starting a garden verb, matching web's
    /// `plantingActionLabels`/explanation copy.
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
    static let save = "Save"
    static let cancel = "Cancel"
    static let notes = "Notes"
    static let notesPlaceholder = "Anything useful to remember"
    static let gardenJournal = "Garden journal"

    // MARK: - Dates

    static let date = "Date"
    static let inThisLocationSince = "In this location since"
    static let confirmLocationDates = "Confirm location dates"
    static let correctLocationDates = "Correct location dates"
    static let recordedAsActual = "Actual date"
    static let recordedAsLater = "Recorded later"
    static let earlierPresenceUnknown =
        "Earlier presence is unknown. Add a date you know to include older bed photos."

    // MARK: - Guides

    static let viewSource = "View source"
    static let reviewed = "Reviewed"
    static let publishedOrRevised = "Published/revised"
    static let basedOn = "Based on"
    static let sourcesMayDiffer =
        "Sources may differ. Use the windows as local context; your bed's conditions still matter."

    // MARK: - Empty / error states

    static let noGardenLocationsYet = "No garden locations yet"
    static let noGardenLocationsDescription = "Add a growing area, then add what is growing."
    static let couldNotLoadGarden = "Couldn't load the garden"
    static let retry = "Retry"
}
