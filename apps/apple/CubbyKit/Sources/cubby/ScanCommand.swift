import ArgumentParser
import CubbyKit

/// Scans one raw code at a location — the CLI's stand-in for `DataScannerView` on a device that
/// has no camera. The server classifies the code; an unreadable one is its validation error.
struct Scan: AsyncParsableCommand {
    static let configuration = CommandConfiguration(abstract: "Scan or type a code at a location.")

    @OptionGroup var global: GlobalOptions
    @Argument(help: "Location shortcode, e.g. LOC-2345.")
    var locationID: String
    @Argument(help: "A barcode, ISBN, or Cubby product shortcode/label URL.")
    var code: String

    func run() async throws {
        try await CLI.run {
            let context = try CLIContext.make(from: global)
            let result = try await context.client.scan(raw: code, at: LocationCode(locationID))

            print("\(result.outcome.rawValue): \(result.product.name)")
            for stray in result.strays {
                let suffix = stray.ambiguousQuantity ? " (ambiguous quantity)" : ""
                print("  stray: \(stray.entryId.rawValue) at \(stray.location.name)\(suffix)")
            }
        }
    }
}
