import Foundation
import Testing
@testable import ShipkitKit

@Suite("Knowing whether an agent is there")
struct AgentPresenceTests {
    @Test func noAgentIsAttachedToBeginWith() async {
        let presence = AgentPresence()

        #expect(await presence.isAttached == false)
        #expect(await presence.count == 0)
    }

    @Test func anAttachedAgentIsSeen() async {
        let presence = AgentPresence()

        await presence.attach(id: 7, name: "claude")

        #expect(await presence.isAttached)
        #expect(await presence.agents.first?.name == "claude")
    }

    // The connection ending is the only signal there is, and it is enough: the
    // kernel reports a vanished peer as end-of-file, so no heartbeat is needed.
    @Test func anAgentThatWentAwayIsNotCountedAsThere() async {
        let presence = AgentPresence()
        await presence.attach(id: 7, name: "claude")

        await presence.detach(id: 7)

        #expect(await presence.isAttached == false)
    }

    @Test func twoAgentsOnOneMachineAreBothCounted() async {
        let presence = AgentPresence()

        await presence.attach(id: 7, name: "claude")
        await presence.attach(id: 8, name: "codex")

        #expect(await presence.count == 2)
        // One leaving must not take the other's presence with it.
        await presence.detach(id: 7)
        #expect(await presence.isAttached)
    }

    // A file descriptor is reused once it closes. Refusing a repeated id, or
    // keeping the older entry, would claim an agent that is gone under a number
    // the kernel has since handed out again.
    @Test func aReusedDescriptorReplacesTheOlderEntryRatherThanBeingRefused() async {
        let presence = AgentPresence()
        await presence.attach(id: 7, name: "gone", now: Date(timeIntervalSince1970: 1))

        await presence.attach(id: 7, name: "fresh", now: Date(timeIntervalSince1970: 2))

        #expect(await presence.count == 1)
        #expect(await presence.agents.first?.name == "fresh")
    }

    @Test func detachingSomethingNeverAttachedChangesNothing() async {
        let presence = AgentPresence()
        await presence.attach(id: 7, name: "claude")

        await presence.detach(id: 99)

        #expect(await presence.count == 1)
    }

    // The menu lists them, and a list that reshuffles between openings is one
    // people misread.
    @Test func agentsComeBackOldestFirst() async {
        let presence = AgentPresence()
        await presence.attach(id: 9, name: "second", now: Date(timeIntervalSince1970: 20))
        await presence.attach(id: 3, name: "first", now: Date(timeIntervalSince1970: 10))

        #expect(await presence.agents.map(\.name) == ["first", "second"])
    }
}
