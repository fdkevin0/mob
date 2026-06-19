import Foundation
import GRPCCore
import GRPCNIOTransportHTTP2
@testable import MobKit

/// An in-process fake of the `Deliberation` gRPC service: it replays a scripted
/// list of `DeliberationEvent`s over a real HTTP/2 loopback transport and records
/// the `ClientMessage`s it receives. This exercises the *real* `GRPCDeliberationService`
/// client (proto mapping + transport) with no model and no external network — the
/// server-facing half of the client harness later slices reuse.
final class FakeDeliberationServer: Mob_V1_Deliberation.SimpleServiceProtocol {
    private let script: [Mob_V1_DeliberationEvent]
    let recorder = Recorder()

    init(script: [Mob_V1_DeliberationEvent]) {
        self.script = script
    }

    func deliberate(
        request: RPCAsyncSequence<Mob_V1_ClientMessage, any Error>,
        response: RPCWriter<Mob_V1_DeliberationEvent>,
        context: ServerContext
    ) async throws {
        // Record everything the client sends (start + any steering) for assertion,
        // concurrently with replaying the script so the stream never blocks.
        let recorder = recorder
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                for try await message in request {
                    await recorder.record(message)
                }
            }
            for event in script {
                try await response.write(event)
            }
            try await group.waitForAll()
        }
    }

    actor Recorder {
        private(set) var messages: [Mob_V1_ClientMessage] = []
        func record(_ message: Mob_V1_ClientMessage) { messages.append(message) }

        var start: Mob_V1_StartDeliberation? {
            messages.compactMap { msg -> Mob_V1_StartDeliberation? in
                if case .start(let s) = msg.message { return s }
                return nil
            }.first
        }

        var steering: [Mob_V1_SteeringInput] {
            messages.compactMap { msg in
                if case .steering(let s) = msg.message { return s }
                return nil
            }
        }
    }
}

/// Run `body` against a freshly-started `GRPCDeliberationService` wired to an
/// in-process `FakeDeliberationServer` replaying `script`. Tears the server down
/// on return. Returns the server (for inspecting recorded inbound messages).
@discardableResult
func withFakeDeliberationServer(
    script: [Mob_V1_DeliberationEvent],
    _ body: @Sendable (GRPCDeliberationService, FakeDeliberationServer) async throws -> Void
) async throws -> FakeDeliberationServer {
    let server = FakeDeliberationServer(script: script)
    let transport = HTTP2ServerTransport.Posix(
        address: .ipv4(host: "127.0.0.1", port: 0),
        transportSecurity: .plaintext
    )
    try await withGRPCServer(transport: transport, services: [server]) { _ in
        let address = try await transport.listeningAddress
        guard let port = address.ipv4?.port else {
            throw FakeServerError.noBoundPort
        }
        let client = GRPCDeliberationService(host: "127.0.0.1", port: port)
        try await body(client, server)
    }
    return server
}

enum FakeServerError: Error { case noBoundPort }
