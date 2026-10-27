import CubbyKit
import SwiftUI
import Testing

@testable import Cubby

@MainActor
@Suite("Navigation")
struct NavigationTests {
    #if os(macOS)
        /// Mac Settings is a separate window, so a section stored by an older build must not put
        /// Settings back in the main window.
        @Test func restoringAStoredSettingsSectionKeepsTheMainWindowAndBrowseContext() throws {
            let navigator = Navigator()
            navigator.macDestination = .entity(.product)
            let selection = record(.product, "PRD-1")
            navigator.selectedRecords[.browse] = selection
            navigator.paths[.browse] = [.entityDetail(.product, id: "PRD-1")]
            let saved = try JSONEncoder().encode(navigator.restoration)

            let restored = Navigator()
            restored.restore(section: AppSection.settings.rawValue, navigation: saved)
            #expect(restored.section == .today)
            restored.macDestination = .entity(.product)
            #expect(restored.selectedRecords[.browse] == selection)
            #expect(restored.paths[.browse] == [.entityDetail(.product, id: "PRD-1")])
        }
    #endif

    @Test func sharedSidebarRoutesNativeListsAndPreservesConfiguredWebOrigin() throws {
        let server = try #require(URL(string: "https://cubby.example.com:8443/"))
        let destinations = SidebarManifest.sections.flatMap(\.destinations)
        for destination in destinations {
            if let entity = destination.entity {
                #expect(EntityCatalog.all.contains { $0.key == entity })
                if EntityCatalog.browsable.contains(where: { $0.key == entity }),
                    entity.nativeActions.contains(.list)
                {
                    #expect(destination.nativeDestination == .entity(entity))
                    continue
                }
                #expect(destination.nativeDestination == nil)
            }
            if destination.nativeDestination == nil {
                let url = WebHandoff(baseURL: server).url(destination.webTarget)
                #expect(url.scheme == server.scheme)
                #expect(url.host == server.host)
                #expect(url.port == server.port)
                #expect(url.path == destination.route)
            }
        }
        #expect(destinations.first { $0.route == "/" }?.nativeDestination == .section(.today))
        #expect(destinations.first { $0.route == "/activity" }?.nativeDestination == .section(.activity))
        #expect(destinations.first { $0.route == "/graph" }?.nativeDestination == .section(.graph))
        #expect(destinations.first { $0.route == "/work-queue" }?.nativeDestination == nil)
        #expect(destinations.first { $0.route == "/problems" }?.nativeDestination == nil)
    }

    @Test func nonBrowsableEntityHasNoNativeSidebarOrLibraryList() throws {
        let destination = try #require(
            SidebarManifest.sections.flatMap(\.destinations).first { $0.entity == .job })
        #expect(EntityKey.job.nativeActions.contains(.list))
        #expect(!EntityCatalog.browsable.contains { $0.key == .job })
        #expect(destination.nativeDestination == nil)
        #expect(destination.webTarget == .route(path: destination.route))
    }

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

    @Test func windowRestorationRetainsDestinationSelectionAndIndependentPaths() throws {
        let original = Navigator()
        original.macDestination = .entity(.product)
        original.selectRecord(record(.product, "PRD-2345"), in: .browse)
        original.paths[.browse] = [.entityDetail(.location, id: "LOC-2345")]
        original.paths[.capture] = [.identify]
        original.paths[.activity] = [.entityList(.run, filters: EntityFilterState(["status": ["running"]]))]
        let data = try JSONEncoder().encode(original.restoration)
        let restored = Navigator()

        restored.restore(section: original.section.rawValue, navigation: data)
        #expect(restored.macDestination == .entity(.product))
        #expect(restored.restoration == original.restoration)
        restored.macDestination = .section(.today)
        restored.macDestination = .entity(.product)
        #expect(restored.restoration == original.restoration)

        restored.selectFirstRecordIfNeeded([record(.product, "PRD-6789")], in: .browse)
        #expect(restored.selectedRecords[.browse] == record(.product, "PRD-2345"))
        restored.open(.audit(location: LocationCode("LOC-6789")))
        restored.restore(section: original.section.rawValue, navigation: data)
        #expect(restored.section == .capture)
        #expect(restored.paths[.capture] == [.audit(locationID: LocationCode("LOC-6789"))])
    }

    @Test func initialRecordSelectionFillsDetailWithoutDiscardingHistory() {
        let navigator = Navigator()
        navigator.paths[.browse] = [.entityDetail(.location, id: "LOC-2345")]
        navigator.selectFirstRecordIfNeeded([], in: .browse)
        #expect(navigator.selectedRecords[.browse] == nil)
        navigator.selectFirstRecordIfNeeded([record(.product, "PRD-2345")], in: .browse)
        #expect(navigator.selectedRecords[.browse] == record(.product, "PRD-2345"))
        #expect(navigator.paths[.browse] == [.entityDetail(.location, id: "LOC-2345")])
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
        navigator.section = .today
        let base = record(.product, "PRD-1")
        let related = record(.location, "LOC-2")
        var destination: RecordSelection?
        let binding = Binding(get: { destination }, set: { destination = $0 })
        navigator.selectedRecords[.search] = related
        navigator.paths[.search] = [.entityDetail(.location, id: related.id)]

        navigator.open(base, from: .column(.search, compactDestination: binding))
        #if os(macOS)
            #expect(navigator.selectedRecords[.search] == base)
            #expect(navigator.paths[.search] == [])
            #expect(destination == nil)
        #else
            #expect(destination == base)
            #expect(navigator.selectedRecords[.search] == related)
            #expect(navigator.paths[.search] == [.entityDetail(.location, id: related.id)])
        #endif
        #expect(navigator.section == .today)

        // A nested list, including one in a sheet, owns its destination. Opening a row must
        // neither pop Browse's root list nor navigate behind the sheet in Today or Activity.
        for section in [AppSection.today, .activity, .browse] {
            navigator.section = section
            navigator.paths[section] = [.entityList(.product)]
            navigator.selectedRecords[section] = base
            let before = navigator.restoration
            destination = nil

            navigator.open(related, from: .stack(binding))

            #expect(destination == related)
            #expect(navigator.restoration == before)
            #expect(navigator.section == section)
        }
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

    @Test(arguments: [AppSection.today, .search])
    func inPlaceEntityLinkRetainsOriginatingHistory(section: AppSection) {
        let navigator = Navigator()
        navigator.section = section
        navigator.paths[section] = [.needsPhoto(locationID: nil)]

        navigator.openInPlace(.entity(.product, id: "PRD-1"))

        #expect(navigator.section == section)
        #expect(
            navigator.paths[section] == [
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
            // ⌘0 is Dev's own command; it is not numbered beside the sidebar's sections.
            #expect(!AppSection.tabs.contains(.dev))
        #endif
    }

    @Test func menuCommandsTargetTheRecordInFrontThenTheList() {
        let navigator = Navigator()
        let handoff = WebHandoff(baseURL: URL(string: "https://cubby.example.invalid")!)
        func url() -> String? { navigator.commandTarget.map { handoff.url($0.webTarget).absoluteString } }

        navigator.section = .browse
        navigator.browseKey = .expense
        #expect(url() == "https://cubby.example.invalid/expenses")

        navigator.selectedRecords[.browse] = record(.expense, "EXP-4K7M")
        #expect(url() == "https://cubby.example.invalid/EXP-4K7M")

        navigator.paths[.browse] = [.entityDetail(.product, id: "PRD-4K7M")]
        #expect(url() == "https://cubby.example.invalid/PRD-4K7M")

        navigator.section = .activity
        navigator.selectedActivity = .serverRun("RUN-4K7M")
        #expect(url() == "https://cubby.example.invalid/RUN-4K7M")

        navigator.section = .today
        #expect(navigator.commandTarget == nil)
    }

    #if os(iOS)
        @Test func compactSettingsRetainsItsDetailAndOtherTabHistory() {
            let navigator = Navigator()
            navigator.paths[.today] = [.activityList]
            navigator.paths[.browse] = [.photosLibrary]
            navigator.phoneTab = .settings
            navigator.paths[.settings] = [.dev]

            navigator.adaptSettingsToCompactNavigation()

            #expect(navigator.phoneTab == .work)
            #expect(navigator.paths[.today] == [.activityList, .settings, .dev])
            #expect(navigator.paths[.browse] == [.photosLibrary])
            navigator.adaptSettingsToCompactNavigation()
            #expect(navigator.paths[.today] == [.activityList, .settings, .dev])
        }

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

            #expect(PhoneTab.work.title == "Today")
            #expect(PhoneTab.work.symbol == "sun.horizon")
            #expect(PhoneTab.find.title == "Search")

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
                    .activityList, .entityDetail(.run, id: "RUN-4K7M"),
                ])
        }
    #endif

    @Test func workspaceReplacementRemovesTheAbsorbedRecordFromBackHistory() throws {
        let message = try NativeWorkspaceMessage.decode([
            "version": 1, "type": "navigate", "entity": "inventory", "id": "INV-4K7M", "replace": true,
        ])
        let destination = try #require(message.record)
        #expect(message.replace)
        let navigator = Navigator()
        navigator.section = .browse
        navigator.paths[.browse] = [.entityList(.inventory), .entityDetail(.inventory, id: "INV-7M4K")]

        navigator.replaceCurrentRecord(with: record(destination.entity, destination.id))

        #expect(
            navigator.paths[.browse] == [.entityList(.inventory), .entityDetail(.inventory, id: "INV-4K7M")])
    }

    #if os(macOS)
        @Test func workspaceReplacementUpdatesTheSelectedRecordWithoutAddingHistory() {
            let navigator = Navigator()
            navigator.section = .browse
            navigator.selectedRecords[.browse] = record(.inventory, "INV-7M4K")

            navigator.replaceCurrentRecord(with: record(.inventory, "INV-4K7M"))

            #expect(navigator.selectedRecords[.browse] == record(.inventory, "INV-4K7M"))
            #expect(navigator.paths[.browse]?.isEmpty != false)
        }
    #endif

    // B1: a briefing row nested its title link inside the row link, and one tap pushed two
    // screens. The row is now exactly one link to its task; the project it mentions is a menu
    // reference and Done is a command beside the link.
    @Test func aBriefingRowIsExactlyOneLinkToItsTask() throws {
        let report = try JSONDecoder().decode(
            EntityReportOut.self,
            from: Data(
                #"""
                {"blocks":[{"kind":"records","empty":"No tasks","rows":[{"entity":"task","id":"TSK-2345",
                 "title":"Water seedlings","trailing":null,
                 "lines":[{"text":"Garden refresh","ref":{"entity":"project","id":"PRJ-2345"}}],
                 "commands":[{"id":"complete","label":"Done","prominent":true,"confirm":null,
                  "request":{"kind":"operation","operation":"entity.mutate","body":{"action":"update",
                  "entity":"task","id":"TSK-2345","data":{"status":"done"}}}}]}]}]}
                """#.utf8))
        let rows = ReportPresentation(report).blocks.flatMap { block -> [ReportPresentation.RecordRow] in
            if case .records(let records) = block { return records.rows }
            return []
        }
        let row = try #require(rows.first)
        let links = RecordRowLinks(row)
        #expect(links.destination == .entityDetail(.task, id: "TSK-2345"))
        #expect(links.references == [.init(label: "Garden refresh", record: record(.project, "PRJ-2345"))])
        #expect(links.list == nil && links.urls.isEmpty)
        #expect(row.commands.map(\.id) == ["complete"])
    }

    private func record(_ key: EntityKey, _ id: String) -> RecordSelection {
        RecordSelection(key: key, id: id)
    }
}
