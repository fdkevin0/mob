import Foundation

/// An app-facing event crossing the `Deliberate` seam, decoupled from generated
/// proto types so view models and tests never import them.
public enum DeliberationStreamEvent: Sendable, Equatable {
    case status(DeliberationPhase)
    case speakerChanged(String)
    case token(speakerID: String, text: String)
    case synthesis(SynthesisResult)
    case error(code: String, message: String)
}

/// A director steering action sent up the stream. Defined for the contract; the
/// Slice 1 backend accepts but does not yet act on these.
public enum SteeringAction: Sendable, Equatable {
    case interject(String)
    case callOn(personaID: String)
    case cutOff
    case end
}

/// The opening request that must be the first message on the stream.
public struct StartDeliberation: Sendable, Equatable {
    public var cast: [PersonaSpec]
    public var problem: String
    public var config: RunConfig

    public init(cast: [PersonaSpec], problem: String, config: RunConfig = RunConfig()) {
        self.cast = cast
        self.problem = problem
        self.config = config
    }
}

/// The `Deliberate` seam, as the rest of the app sees it. The real gRPC client
/// and the in-test fake server both conform, so the deliberation flow is tested
/// against a scripted stream with no network (PRD Seam 1, client side).
public protocol DeliberationService: Sendable {
    /// Open a deliberation. `steering` carries director actions sent during the
    /// run; the returned stream yields events until the deliberation ends.
    func deliberate(
        start: StartDeliberation,
        steering: AsyncStream<SteeringAction>
    ) -> AsyncThrowingStream<DeliberationStreamEvent, Error>
}
