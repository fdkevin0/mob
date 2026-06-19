import Testing
@testable import MobKit

/// Client render tests (PRD Seam 1, client side): drive the view model against a
/// scripted `DeliberationService` and assert the externally observable behavior —
/// incremental transcript, speaker attribution, status mirroring, synthesis,
/// error folding, and steering emission. No network, no model.
@MainActor
struct DeliberationViewModelTests {
    private func start() -> StartDeliberation {
        StartDeliberation(
            cast: [
                PersonaSpec(id: "ada", name: "Ada"),
                PersonaSpec(id: "boole", name: "Boole"),
            ],
            problem: "Cost or learning?"
        )
    }

    /// A canned happy-path script mirroring the backend's walking skeleton.
    private var cannedScript: [DeliberationStreamEvent] {
        [
            .status(.assembling),
            .status(.debating),
            .speakerChanged("ada"),
            .token(speakerID: "ada", text: "Weigh "),
            .token(speakerID: "ada", text: "cost."),
            .speakerChanged("boole"),
            .token(speakerID: "boole", text: "Speed "),
            .token(speakerID: "boole", text: "wins."),
            .speakerChanged(moderatorPersonaID),
            .token(speakerID: moderatorPersonaID, text: "Synthesizing."),
            .status(.synthesizing),
            .synthesis(
                SynthesisResult(
                    recommendation: "Optimize for learning.",
                    tensions: ["cost vs speed"],
                    dissents: ["cost debt compounds"]
                )
            ),
            .status(.done),
        ]
    }

    @Test func rendersTranscriptIncrementallyWithSpeakerAttribution() async {
        let vm = DeliberationViewModel(service: ScriptedDeliberationService(script: cannedScript))
        await vm.run(start: start())

        // One contiguous turn per speaker change, tokens accumulated in order.
        #expect(vm.transcript.map(\.speakerID) == ["ada", "boole", moderatorPersonaID])
        #expect(vm.transcript.map(\.text) == ["Weigh cost.", "Speed wins.", "Synthesizing."])
        #expect(vm.transcript.last?.isModerator == true)
    }

    @Test func mirrorsStatusToTerminalDone() async {
        let vm = DeliberationViewModel(service: ScriptedDeliberationService(script: cannedScript))
        await vm.run(start: start())

        #expect(vm.phase == .done)
        #expect(vm.isRunning == false)
    }

    @Test func tracksCurrentSpeaker() async {
        let vm = DeliberationViewModel(service: ScriptedDeliberationService(script: cannedScript))
        await vm.run(start: start())

        #expect(vm.currentSpeakerID == moderatorPersonaID)
    }

    @Test func capturesTerminalSynthesis() async {
        let vm = DeliberationViewModel(service: ScriptedDeliberationService(script: cannedScript))
        await vm.run(start: start())

        #expect(vm.synthesis?.recommendation == "Optimize for learning.")
        #expect(vm.synthesis?.tensions == ["cost vs speed"])
        #expect(vm.synthesis?.dissents == ["cost debt compounds"])
    }

    @Test func midStreamFailureSurfacesErrorAndKeepsPartialTranscript() async {
        // Fail after the first three events (status, status, speakerChanged + first token).
        let service = ScriptedDeliberationService(script: cannedScript, failAfter: 4)
        let vm = DeliberationViewModel(service: service)
        await vm.run(start: start())

        #expect(vm.phase == .error)
        #expect(vm.errorMessage != nil)
        // The partial transcript captured before the failure is left intact (PRD story 35).
        #expect(vm.transcript.isEmpty == false)
    }

    @Test func errorEventFoldsToErrorPhase() async {
        let vm = DeliberationViewModel(
            service: ScriptedDeliberationService(script: [
                .status(.debating),
                .error(code: "boom", message: "backend exploded"),
            ])
        )
        await vm.run(start: start())

        #expect(vm.phase == .error)
        #expect(vm.errorMessage == "[boom] backend exploded")
    }

    @Test func steeringActionsReachTheService() async {
        // The service holds the stream open until all four steering actions land,
        // so the assertion does not race the script to completion.
        let service = ScriptedDeliberationService(script: cannedScript, awaitSteeringCount: 4)
        let vm = DeliberationViewModel(service: service)

        let run = Task { await vm.run(start: start()) }
        // Yield so the stream opens before steering is emitted.
        await Task.yield()
        vm.interject("Consider risk.")
        vm.callOn(personaID: "ada")
        vm.cutOff()
        vm.end()
        await run.value

        let received = await service.receivedSteering
        #expect(received.contains(.interject("Consider risk.")))
        #expect(received.contains(.callOn(personaID: "ada")))
        #expect(received.contains(.cutOff))
        #expect(received.contains(.end))
    }
}
