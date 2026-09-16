// Xcode 26 `#Playground` blocks: open this file in Xcode and run any block from the canvas.
// They are exploration aids, not a verification tier (tests and the `cubby` CLI are), and they
// compile to nothing outside Xcode: the whole file is gated on DEBUG and on the Playgrounds
// module being importable, so `swift build`/`swift test` from the terminal are unaffected.
#if DEBUG && canImport(Playgrounds)
    import Foundation
    import Playgrounds

    #Playground("Parse an ingredient line") {
        let parsed = IngredientParser.parse("2 cups flour, sifted (optional)")
        _ = parsed.display
        _ = parsed.amounts
        _ = IngredientParser.sizeUnitAliases.count
    }

    #Playground("Read scanner input offline") {
        let inputs = ["012345678905", "9780306406157", "PRD-2345", "https://cubby.example/LOC-2345", "hello"]
        for input in inputs {
            _ = (CubbyLabel(input), ScanCodes.gtin14(input))
        }
    }

    #Playground("Entity catalog") {
        for descriptor in EntityCatalog.all {
            _ = (
                descriptor.key, descriptor.basePath, descriptor.key.httpActions.contains(.list),
                descriptor.fields.count
            )
        }
    }

    #Playground("Call the API (needs a credential in the CLI token file)") {
        let baseURL = URL(string: "https://cubby.example.com")!
        let credentials = CredentialProvider(
            host: CubbyBaseURL.host(of: baseURL), store: FileSessionTokenStore.standard())
        let client = CubbyClient(baseURL: baseURL, credentials: credentials)
        let page = try await client.locationOptions(page: 1, pageSize: 5)
        _ = page.items.map(\.name)
    }
#endif
