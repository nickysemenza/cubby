/// The credential CubbyAuthMiddleware injects on every request: a Better Auth bearer session
/// token (from `set-auth-token`, obtained via `AuthFlow.signIn`) or a static API key (used by the
/// CLI harness via `CUBBY_API_KEY`/`--api-key`).
public enum CubbyCredential: Sendable, Equatable, Codable {
    case bearer(String)
    case apiKey(String)
}
