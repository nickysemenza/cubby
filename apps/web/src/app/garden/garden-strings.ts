/**
 * Every user-visible garden string, centralized so the web garden forms never
 * inline copy — see `docs/terminology.md` § Garden for the binding glossary
 * this implements. Apple's mirror lives in
 * `apps/apple/App/Shared/Garden/GardenStrings.swift`.
 *
 * The entry-kind vocabulary ("Note" / "Harvest" / "Move") is *not* duplicated
 * here: `gardenEntryKindLabel` in `./garden-photos` is already the one
 * canonical source (shared with the journal's date · kind line), so entry
 * forms import that instead.
 */
/** Shared between `location.addTitle` (dialog title) and `home.addLocation` (trigger). */
const addGrowingAreaTitle = "Add growing area";

export const gardenStrings = {
  common: {
    notesField: "Notes",
    saveLabel: "Save",
    retry: "Retry",
  },
  location: {
    kindLabel: {
      bed: "Raised bed",
      tray: "Seed tray",
      other: "Other",
    } as const,
    addTitle: addGrowingAreaTitle,
    editTitle: "Edit growing area",
    nameField: "Name",
    kindField: "Growing area",
    conditionsField: "Growing conditions",
    existingPickerCaption: "Use an existing location",
    existingPickerPlaceholder: "Search existing locations…",
    parentField: "Parent location (optional)",
    wholeArea: "Whole area",
    noLocationYet: "No location yet",
  },
  planting: {
    addTitle: "Add planting",
    editTitle: "Edit planting",
    verbs: {
      start: "Start planting",
      move: "Move everything",
      split: "Move some seedlings",
      finish: "Finish planting",
    },
    submitAdd: "Add planting",
    cropField: "Crop",
    rememberSourceLabel: "Remember that this product grows this crop",
    locationField: "Location",
    intendedDestinationField: "Intended destination",
    stateField: "Planting state",
    stateGrowing: "Growing now",
    statePlanned: "Planned",
    stateFinished: "Finished",
    sourceField: "Seed packet or plant (optional)",
    varietyField: "Variety",
    quantityField: "Approximate quantity",
    quantityPlaceholder: "A few seedlings",
    plannedWindowField: "Planned window",
    plannedWindowPlaceholder: "Early autumn",
    plannedDateField: "Planned date",
    sowedOnField: "Sowed on",
    transplantedOnField: "Transplanted on",
    inLocationSinceField: "In this location since",
    inLocationSinceHelp:
      "Optional. This confirms which older bed photos belong in the journal. Leave blank to record presence from today without guessing an earlier date.",
    datesDetailsSummary: "Dates and other details (optional)",
    datesHelp: "Leave dates blank when you don’t know them.",
    guideSummary: "Local planting guide",
    guideFieldLabel: "Guide for this ingredient",
    guideNoneOption: "No guide linked",
    startMethodField: "How are you starting?",
    startMethodSow: "Sowing seeds",
    startMethodTransplant: "Planting a seedling or plant",
    startMethodExisting: "Already growing; date unknown",
    splitQuantityField: "Quantity being moved (optional)",
    splitExplanation:
      "Remaining seedlings stay in the original location. The new planting keeps the seed source and sowing history.",
    finishExplanation:
      "This finishes only this planting. Its photos and harvest history stay available.",
    dateField: "Date",
    startingLocationField: "Location",
    destinationField: "Destination",
  },
  entry: {
    kindField: "Entry type",
    dateField: "Date",
    harvestDateField: "Harvest date",
    harvestAmountField: "Harvest amount",
    harvestAmountPlaceholder: "A handful, 6 tomatoes, 300 g…",
    locationField: "Location",
    aboutField: "About",
    aboutHelpWithPlanting:
      "This entry stays in this planting’s journal, even after it moves.",
    aboutHelpWithoutPlanting:
      "Shared with plantings known to be here on the observation date. Unknown earlier dates are not assumed.",
    moveLockedHint:
      "Correct move dates in the planting’s location history so its journal stays consistent.",
    loadFailed: "Could not load locations and plantings.",
  },
  home: {
    addPlanting: "Add planting",
    addLocation: addGrowingAreaTitle,
    finishSelected: (n: number) => `Finish selected (${n})`,
    allEntries: "All entries",
    emptyTitle: "Start with what’s growing today",
    emptyBody:
      "Add a bed, tray, or growing area, then record your crops. Leave unknown dates blank.",
    noPlantingsInLocation: "No current or planned plantings.",
    logEntry: "Log entry",
    editConditions: "Edit growing area",
    bedJournal: "Area journal",
    finishedPlantingsSummary: (n: number) => `Finished plantings (${n})`,
    finishedEmpty: "Finished plantings will stay here with their history.",
    finishDialogTitle: "Finish selected plantings",
    finishSubmit: (label: string) => `Finish ${label}`,
    finishPartialReport: (finished: string, total: string) =>
      `Finished ${finished} of ${total}.`,
    loadFailed: "Could not load the garden",
  },
  photos: {
    entryHelp:
      "Keep the whole area or add a close-up. Photos save with this entry.",
    plantingHelp:
      "Photos of this planting today. They save as its first journal entry.",
  },
} as const;
