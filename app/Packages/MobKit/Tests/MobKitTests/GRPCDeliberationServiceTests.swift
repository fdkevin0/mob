import Testing
import GRPCCore
@testable import MobKit

/// Client transport tests (PRD Seam 1): drive the real `GRPCDeliberationService`
/// against an in-process fake gRPC server replaying a scripted `DeliberationEvent`
/// script. Asserts proto→app event mapping on the way down and app→proto message
/// mapping on the way up — the seam every later slice reuses.
struct GRPCDeliberationServiceTests {
    private func event(_ make: (inout Mob_V1_DeliberationEvent) -> Void) -> Mob_V1_DeliberationEvent {
        var e = Mob_V1_DeliberationEvent()
        make(&e)
        return e
    }

    private var cannedScript: [Mob_V1_DeliberationEvent] {
        [
            event { $0.statusChanged = .with { $0.status = .assembling } },
            event { $0.statusChanged = .with { $0.status = .debating } },
            event { $0.speakerChanged = .with { $0.personaID = "ada" } },
            event { $0.tokenDelta = .with { $0.personaID = "ada"; $0.text = "Cost." } },
            event { $0.speakerChanged = .with { $0.personaID = moderatorPersonaID } },
            event { $0.tokenDelta = .with { $0.personaID = moderatorPersonaID; $0.text = "Done." } },
            event {
                $0.synthesis = .with {
                    $0.recommendation = "Optimize for learning."
                    $0.tensions = ["cost vs speed"]
                    $0.dissents = ["debt compounds"]
                }
            },
            event { $0.statusChanged = .with { $0.status = .done } },
        ]
    }

    private func start() -> StartDeliberation {
        StartDeliberation(
            cast: [PersonaSpec(id: "ada", name: "Ada", traits: ["pragmatic"], tier: .standard)],
            problem: "Cost or learning?",
            config: RunConfig(roundCap: 3)
        )
    }

    @Test func mapsScriptedEventsToAppStreamEvents() async throws {
        try await withFakeDeliberationServer(script: cannedScript) { client, _ in
            let (steering, cont) = AsyncStream<SteeringAction>.makeStream()
            cont.finish()

            var collected: [DeliberationStreamEvent] = []
            for try await event in client.deliberate(start: self.start(), steering: steering) {
                collected.append(event)
            }

            #expect(collected == [
                .status(.assembling),
                .status(.debating),
                .speakerChanged("ada"),
                .token(speakerID: "ada", text: "Cost."),
                .speakerChanged(moderatorPersonaID),
                .token(speakerID: moderatorPersonaID, text: "Done."),
                .synthesis(SynthesisResult(
                    recommendation: "Optimize for learning.",
                    tensions: ["cost vs speed"],
                    dissents: ["debt compounds"]
                )),
                .status(.done),
            ])
        }
    }

    @Test func sendsStartDeliberationCarryingProblemAndCast() async throws {
        let server = try await withFakeDeliberationServer(script: cannedScript) { client, _ in
            let (steering, cont) = AsyncStream<SteeringAction>.makeStream()
            cont.finish()
            for try await _ in client.deliberate(start: self.start(), steering: steering) {}
        }

        let recordedStart = await server.recorder.start
        #expect(recordedStart?.problem == "Cost or learning?")
        #expect(recordedStart?.cast.count == 1)
        #expect(recordedStart?.cast.first?.id == "ada")
        #expect(recordedStart?.cast.first?.tier == .t3Standard)
        #expect(recordedStart?.config.roundCap == 3)
    }

    @Test func mapsSteeringActionsToProtoMessages() async throws {
        let server = try await withFakeDeliberationServer(script: cannedScript) { client, _ in
            let (steering, cont) = AsyncStream<SteeringAction>.makeStream()
            cont.yield(.interject("focus on risk"))
            cont.yield(.callOn(personaID: "ada"))
            cont.yield(.cutOff)
            cont.yield(.end)
            cont.finish()
            for try await _ in client.deliberate(start: self.start(), steering: steering) {}
        }

        let steering = await server.recorder.steering
        let kinds = steering.compactMap { $0.input }
        #expect(kinds.contains { if case .interject(let i) = $0 { return i.text == "focus on risk" }; return false })
        #expect(kinds.contains { if case .callOn(let c) = $0 { return c.personaID == "ada" }; return false })
        #expect(kinds.contains { if case .cutOff = $0 { return true }; return false })
        #expect(kinds.contains { if case .end = $0 { return true }; return false })
    }
}
