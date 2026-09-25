import CubbyKit
import SwiftUI
import Testing

@testable import Cubby

@MainActor
@Suite("Navigation")
struct NavigationTests {
    @Test func sidebarEntitySelectionOwnsBrowseDestination() {
        let navigator = Navigator()
        navigator.selectedRecords[.browse] = record(.location, "LOC-OLD")
        navigator.paths[.browse] = [.entityDetail(.location, id: "LOC-OLD")]

        navigator.macDestination = .entity(.product)

        #expect(navigator.section == .browse)
        #expect(navigator.browseKey == .product)
        #expect(navigator.selectedRecords[.browse] == nil)
        #expect(navigator.paths[.browse] == [])
        #expect(navigator.macDestination == .entity(.product))
    }

    @Test func selectingSameSidebarEntityPreservesRecordContext() {
        let navigator = Navigator()
        let selection = record(.product, "PRD-1")
        navigator.macDestination = .entity(.product)
        navigator.selectedRecords[.browse] = selection
        navigator.paths[.browse] = [.entityDetail(.location, id: "LOC-RELATED")]

        navigator.macDestination = .entity(.product)

        #expect(navigator.selectedRecords[.browse] == selection)
        #expect(navigator.paths[.browse] == [.entityDetail(.location, id: "LOC-RELATED")])
    }

    @Test func selectingBrowseRootClearsSpecializedBrowseDestination() {
        let navigator = Navigator()
        navigator.macDestination = .entity(.location)
        navigator.selectedRecords[.browse] = record(.product, "PRD-1")
        navigator.paths[.browse] = [.entityDetail(.location, id: "LOC-1")]

        navigator.macDestination = .section(.browse)

        #expect(navigator.section == .browse)
        #expect(navigator.browseKey == nil)
        #expect(navigator.macDestination == .section(.browse))
        #expect(navigator.selectedRecords[.browse] == nil)
        #expect(navigator.paths[.browse] == [])
    }

    @Test func recordSelectionClearsOnlyItsSectionsDetailHistory() {
        let navigator = Navigator()
        navigator.paths[.browse] = [.entityDetail(.location, id: "LOC-RELATED")]
        navigator.paths[.search] = [.entityDetail(.recipe, id: "RCP-RELATED")]

        navigator.selectRecord(record(.product, "PRD-1"), in: .browse)

        #expect(navigator.selectedRecords[.browse] == record(.product, "PRD-1"))
        #expect(navigator.paths[.browse] == [])
        #expect(navigator.paths[.search] == [.entityDetail(.recipe, id: "RCP-RELATED")])
    }

    @Test func pathBindingsRemainIndependentAcrossSections() {
        let navigator = Navigator()
        let browsePath = navigator.path(for: .browse)
        let searchPath = navigator.path(for: .search)

        browsePath.wrappedValue = [.entityList(.product)]
        searchPath.wrappedValue = [.entityDetail(.recipe, id: "RCP-1")]

        #expect(browsePath.wrappedValue == [.entityList(.product)])
        #expect(searchPath.wrappedValue == [.entityDetail(.recipe, id: "RCP-1")])
    }

    @Test func openingRecordUsesPlatformNavigationContract() {
        let navigator = Navigator()
        navigator.section = .search
        let base = record(.product, "PRD-1")
        let related = record(.location, "LOC-2")

        navigator.openRecord(base)
        #if os(macOS)
            #expect(navigator.selectedRecords[.search] == base)
            #expect(navigator.paths[.search] == [])
        #else
            #expect(navigator.selectedRecords[.search] == nil)
            #expect(navigator.paths[.search] == [.entityDetail(.product, id: "PRD-1")])
        #endif

        navigator.openRecord(related)
        #if os(macOS)
            #expect(navigator.selectedRecords[.search] == base)
            #expect(navigator.paths[.search] == [.entityDetail(.location, id: "LOC-2")])
        #else
            #expect(
                navigator.paths[.search] == [
                    .entityDetail(.product, id: "PRD-1"),
                    .entityDetail(.location, id: "LOC-2"),
                ])
        #endif
    }

    @Test func entityDeepLinkReplacesWarmBrowseDetail() {
        let navigator = Navigator()
        navigator.section = .browse
        navigator.browseKey = .location
        navigator.selectedRecords[.browse] = record(.location, "LOC-OLD")
        navigator.paths[.browse] = [.entityDetail(.recipe, id: "RCP-OLD")]

        navigator.open(.entity(.product, id: "PRD-NEW"))

        #expect(navigator.launchLinkApplied)
        #expect(navigator.section == .browse)
        #if os(macOS)
            #expect(navigator.browseKey == .product)
            #expect(navigator.selectedRecords[.browse] == record(.product, "PRD-NEW"))
            #expect(navigator.paths[.browse] == [])
        #else
            #expect(navigator.paths[.browse] == [.entityDetail(.product, id: "PRD-NEW")])
        #endif
    }

    @Test func inPlaceEntityLinkRetainsOriginatingHistory() {
        let navigator = Navigator()
        navigator.section = .today
        navigator.paths[.today] = [.needsPhoto(locationID: nil)]

        navigator.openInPlace(.entity(.product, id: "PRD-1"))

        #expect(navigator.section == .today)
        #expect(
            navigator.paths[.today] == [
                .needsPhoto(locationID: nil),
                .entityDetail(.product, id: "PRD-1"),
            ])
    }

    @Test func workflowDeepLinksSelectTheirSectionAndRootPath() {
        let navigator = Navigator()
        let location = LocationCode("LOC-1")

        navigator.open(.capture(location: location))
        #expect(navigator.section == .capture)
        #expect(navigator.paths[.capture] == [])
        #expect(navigator.takeCaptureLocation() == location)
        #expect(navigator.takeCaptureLocation() == nil)

        navigator.open(.audit(location: location))
        #expect(navigator.section == .capture)
        #expect(navigator.paths[.capture] == [.audit(locationID: location)])

        navigator.open(.identify)
        #expect(navigator.section == .capture)
        #expect(navigator.paths[.capture] == [.identify])

        navigator.open(.search)
        #expect(navigator.section == .search)
        #expect(navigator.paths[.search] == [])

        navigator.open(.today)
        #expect(navigator.section == .today)
        #expect(navigator.paths[.today] == [])
    }

    @Test func pendingValuesAreConsumedOnce() {
        let navigator = Navigator()
        navigator.pendingCaptureCode = "0123456789012"
        navigator.pendingSearchQuery = "tomatoes"

        #expect(navigator.takeCaptureCode() == "0123456789012")
        #expect(navigator.takeCaptureCode() == nil)
        #expect(navigator.takeSearchQuery() == "tomatoes")
        #expect(navigator.takeSearchQuery() == nil)
    }

    @Test func developerDestinationFollowsPlatformShell() {
        let navigator = Navigator()
        navigator.section = .photos

        navigator.open(.dev)

        #if os(iOS)
            #expect(navigator.section == .photos)
            #expect(navigator.paths[.browse] == [.dev])
            #expect(!AppSection.tabs.contains(.dev))
        #else
            #expect(navigator.section == .dev)
            #expect(navigator.paths[.dev] == [])
            #expect(AppSection.tabs.contains(.dev))
        #endif
    }

    #if os(iOS)
        @Test func phoneTabsKeepIndependentNavigationPaths() {
            let navigator = Navigator()
            let work = navigator.path(for: PhoneTab.work)
            let library = navigator.path(for: PhoneTab.library)
            work.wrappedValue = [.activityList]
            library.wrappedValue = [.photosLibrary]

            navigator.phoneTab = .find
            #expect(navigator.phoneTab == .find)
            #expect(work.wrappedValue == [.activityList])
            #expect(library.wrappedValue == [.photosLibrary])
        }

        @Test func legacyLinksLandInVisiblePhoneDestinations() {
            let navigator = Navigator()

            navigator.open(.photos)
            #expect(navigator.phoneTab == .library)
            #expect(navigator.path(for: PhoneTab.library).wrappedValue == [.photosLibrary])

            navigator.open(.activity(run: "RUN-4K7M"))
            #expect(navigator.phoneTab == .work)
            #expect(navigator.path(for: PhoneTab.work).wrappedValue == [.activityList])
            #expect(navigator.selectedActivity == .serverRun("RUN-4K7M"))

            navigator.openPhotoReview(runID: "RUN-4K7M")
            #expect(navigator.selectedActivity == nil)
            #expect(
                navigator.path(for: PhoneTab.work).wrappedValue == [
                    .activityList, .photoReview("RUN-4K7M"),
                ])
        }
    #endif

    private func record(_ key: EntityKey, _ id: String) -> RecordSelection {
        RecordSelection(key: key, id: id)
    }
}
