import SwiftUI
import ShipkitKit

/// How shipkit is pushing on one item, as a shape and a colour rather than a
/// word buried in a sentence. A refusal and a suggestion look different here
/// because they *are* different, and a pane that drew them identically would
/// be lying about what happens next.
private func severityIcon(_ severity: String) -> (name: String, tint: Color) {
    switch severity {
    case "refuses": return ("xmark.octagon.fill", .red)
    case "warns": return ("exclamationmark.triangle.fill", .orange)
    default: return ("lightbulb", .secondary)
    }
}

/// The channel an item came out of, spelled for a person rather than for the
/// router. `readiness` is the team's own checklist, which is the thing people
/// most want to recognise at a glance.
private func channelLabel(_ kind: String) -> String {
    switch kind {
    case "finding": return "rule"
    case "warning": return "warning"
    case "readiness": return "checklist"
    default: return "advice"
    }
}

/// One review, answerable here instead of in the browser.
///
/// The diff is deliberately absent: a popover is the wrong shape for four
/// hundred files, the page is one click away, and the file rows carry a button
/// that opens the file where it can actually be read.
struct ReviewPane: View {
    @ObservedObject var model: AppModel
    let offer: PendingReview

    private var request: ReviewRequest { offer.request }

    private var pickedCount: Int {
        request.items.filter { model.reviewPicks[$0.id] == true }.count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header

            if request.items.isEmpty {
                Text("shipkit found nothing to say about this change.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(request.items) { item in
                            itemRow(item)
                        }
                    }
                    .padding(.trailing, 4)
                }
                // Bounded so a change with thirty findings does not grow the
                // popover past the screen; the files section below has to stay
                // reachable without scrolling the whole pane.
                .frame(maxHeight: 260)
            }

            if request.files.isEmpty == false {
                filesSection
            }

            Divider()
            actions
        }
        .padding(14)
        .frame(width: 460)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Review · \(request.repo)")
                .font(.headline)
            Text("\(request.branch) → \(request.base)")
                .font(.callout)
                .foregroundStyle(.secondary)
            if request.commitMessage.isEmpty == false {
                Text(request.commitMessage)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if request.diffstat.isEmpty == false {
                Text(request.diffstat.trimmingCharacters(in: .whitespacesAndNewlines))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Text("Nothing is committed or pushed. This answer goes back to the agent.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func itemRow(_ item: OfferedItem) -> some View {
        let icon = severityIcon(item.severity)
        let picked = Binding(
            get: { model.reviewPicks[item.id] ?? false },
            set: { model.reviewPicks[item.id] = $0 }
        )
        let note = Binding(
            get: { model.reviewNotes[item.id] ?? "" },
            set: { model.reviewNotes[item.id] = $0 }
        )
        return VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Toggle(isOn: picked) { EmptyView() }
                    .toggleStyle(.checkbox)
                    .labelsHidden()
                Image(systemName: icon.name)
                    .foregroundStyle(icon.tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.message)
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("\(channelLabel(item.kind)) · \(item.id)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            // The note field appears only once the box is ticked. An untouched
            // pane of thirty items should read as a list, not as a form.
            if picked.wrappedValue {
                TextField("Note to the agent (optional)", text: note, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...3)
                    .padding(.leading, 26)
            }
        }
    }

    private var filesSection: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("\(request.files.count) file\(request.files.count == 1 ? "" : "s") changed")
                .font(.caption)
                .foregroundStyle(.secondary)
            ScrollView {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(request.files) { file in
                        HStack(spacing: 6) {
                            Text(file.path)
                                .font(.caption.monospaced())
                                .lineLimit(1)
                                .truncationMode(.head)
                            Spacer(minLength: 6)
                            Text(file.status)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Button("Open") { model.openInEditor(file.path) }
                                .buttonStyle(.link)
                                .font(.caption)
                        }
                    }
                }
            }
            .frame(maxHeight: 110)
        }
    }

    private var actions: some View {
        VStack(alignment: .leading, spacing: 8) {
            // The primary action is the full editor, not an answer.
            //
            // This pane used to carry one button whose words changed with what
            // was ticked, so with nothing ticked the only thing on screen said
            // "Nothing to fix" — and a person with an unread list in front of
            // them pressed the only button there was and thereby answered "this
            // change is fine". The list was right there with its checkboxes; the
            // action was the trap. Opening the page is now the obvious thing to
            // do, and answering from here is deliberately the smaller gesture.
            Button {
                model.openReviewPage()
            } label: {
                Label("Open in shipkit", systemImage: "arrow.up.forward.app")
                    .frame(maxWidth: .infinity)
            }
            .keyboardShortcut(.defaultAction)
            .controlSize(.large)

            HStack {
                Text(pickedCount == 0
                    ? "or tick above and send from here"
                    : "\(pickedCount) of \(request.items.count) ticked")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Send \(pickedCount)") { model.sendReview() }
                    .font(.caption)
                    // Nothing ticked is not something to send. It is a separate
                    // statement, and it has its own button below.
                    .disabled(pickedCount == 0)
                Button("Nothing to fix") { model.sendNothingToFix() }
                    .buttonStyle(.link)
                    .font(.caption)
            }
        }
    }
}
