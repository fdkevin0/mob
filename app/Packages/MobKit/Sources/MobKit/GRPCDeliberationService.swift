import Foundation
import GRPCCore
import GRPCNIOTransportHTTP2
import GRPCProtobuf

/// The real `DeliberationService`: dials the backend over gRPC bidirectional
/// streaming and maps generated proto types to the app-facing event/action
/// shapes. The rest of the app depends only on `DeliberationService`, so this is
/// the single place generated types are touched on the client.
public struct GRPCDeliberationService: DeliberationService {
    public let host: String
    public let port: Int

    public init(host: String = "127.0.0.1", port: Int = 50051) {
        self.host = host
        self.port = port
    }

    public func deliberate(
        start: StartDeliberation,
        steering: AsyncStream<SteeringAction>
    ) -> AsyncThrowingStream<DeliberationStreamEvent, Error> {
        let host = host
        let port = port
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let transport = try HTTP2ClientTransport.Posix(
                        target: .dns(host: host, port: port),
                        transportSecurity: .plaintext
                    )
                    try await withGRPCClient(transport: transport) { client in
                        let service = Mob_V1_Deliberation.Client(wrapping: client)
                        try await service.deliberate(
                            requestProducer: { writer in
                                try await writer.write(Self.makeStart(start))
                                for await action in steering {
                                    try await writer.write(Self.makeSteering(action))
                                }
                            },
                            onResponse: { response in
                                for try await event in response.messages {
                                    if let mapped = Self.map(event) {
                                        continuation.yield(mapped)
                                    }
                                }
                            }
                        )
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: App -> proto

    private static func makeStart(_ start: StartDeliberation) -> Mob_V1_ClientMessage {
        var startMsg = Mob_V1_StartDeliberation()
        startMsg.problem = start.problem
        startMsg.cast = start.cast.map { spec in
            var p = Mob_V1_Persona()
            p.id = spec.id
            p.name = spec.name
            p.traits = spec.traits
            p.systemPrompt = spec.systemPrompt
            p.tier = spec.tier.proto
            return p
        }
        var config = Mob_V1_RunConfig()
        config.roundCap = start.config.roundCap
        config.convergenceHint = start.config.convergenceHint
        startMsg.config = config

        var message = Mob_V1_ClientMessage()
        message.start = startMsg
        return message
    }

    private static func makeSteering(_ action: SteeringAction) -> Mob_V1_ClientMessage {
        var steering = Mob_V1_SteeringInput()
        switch action {
        case .interject(let text):
            var i = Mob_V1_Interject()
            i.text = text
            steering.interject = i
        case .callOn(let personaID):
            var c = Mob_V1_CallOn()
            c.personaID = personaID
            steering.callOn = c
        case .cutOff:
            steering.cutOff = Mob_V1_CutOff()
        case .end:
            steering.end = Mob_V1_EndDeliberation()
        }
        var message = Mob_V1_ClientMessage()
        message.steering = steering
        return message
    }

    // MARK: proto -> app

    private static func map(_ event: Mob_V1_DeliberationEvent) -> DeliberationStreamEvent? {
        switch event.event {
        case .tokenDelta(let t):
            return .token(speakerID: t.personaID, text: t.text)
        case .speakerChanged(let s):
            return .speakerChanged(s.personaID)
        case .statusChanged(let s):
            return .status(DeliberationPhase(s.status))
        case .synthesis(let s):
            return .synthesis(
                SynthesisResult(
                    recommendation: s.recommendation,
                    tensions: s.tensions,
                    dissents: s.dissents
                )
            )
        case .error(let e):
            return .error(code: e.code, message: e.message)
        case .none:
            return nil
        }
    }
}
