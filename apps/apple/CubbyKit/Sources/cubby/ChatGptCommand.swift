#if os(macOS)
    import ArgumentParser
    import CubbyKit

    struct ChatGptCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "chatgpt", abstract: "Connect Cubby to your ChatGPT plan.",
            subcommands: [Connect.self])

        struct Connect: AsyncParsableCommand {
            static let configuration = CommandConfiguration(
                abstract: "Open ChatGPT sign-in using your stored Cubby login.")
            @OptionGroup var global: GlobalOptions

            func run() async throws {
                try await CLI.run {
                    let context = try CLIContext.make(from: global)
                    guard await context.credentials.current() != nil else {
                        throw CLIError.message(
                            "Sign in to Cubby first: cubby auth login --base-url \(context.baseURL.absoluteString)"
                        )
                    }
                    print("Opening ChatGPT sign-in…")
                    _ = try await ChatGptSignIn.connect(client: context.client)
                    print("Connected. Refresh Cubby Settings to see your available models.")
                }
            }
        }
    }
#endif
