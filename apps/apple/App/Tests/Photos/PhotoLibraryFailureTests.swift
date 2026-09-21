import Foundation
import Photos
import Testing

@testable import Cubby

@Suite("Photo library failures")
struct PhotoLibraryFailureTests {
    @Test func networkAccessRequiredBecomesCloudUnavailable() {
        let error = NSError(domain: PHPhotosErrorDomain, code: 3164)

        let normalized = PhotoLibraryFailure.normalizing(error)

        #expect(PhotoLibraryFailure.isCloudUnavailable(normalized))
        #expect(
            normalized.localizedDescription
                == "This photo needs to download from iCloud. Select it to download, or try again when connected."
        )
    }

    @Test func wrappedNetworkAccessRequiredBecomesCloudUnavailable() {
        let photosError = NSError(domain: PHPhotosErrorDomain, code: 3164)
        let wrapped = NSError(
            domain: "PhotoLibraryFailureTests.Wrapper", code: 1,
            userInfo: [NSUnderlyingErrorKey: photosError])

        #expect(PhotoLibraryFailure.isCloudUnavailable(PhotoLibraryFailure.normalizing(wrapped)))
    }

    @Test func unrelatedPhotoFailureRemainsReportable() {
        let error = NSError(domain: PHPhotosErrorDomain, code: 3169)

        let normalized = PhotoLibraryFailure.normalizing(error)

        #expect(!PhotoLibraryFailure.isCloudUnavailable(normalized))
        #expect((normalized as NSError).domain == PHPhotosErrorDomain)
        #expect((normalized as NSError).code == 3169)
    }
}
