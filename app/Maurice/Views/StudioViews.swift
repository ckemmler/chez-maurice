import SwiftUI

// MARK: - Maurice Studio
//
// The surface for choosing and using specialized Maurices: shared UI state, the
// picker (a centered dialog on regular width, a bottom sheet on compact), and
// the conversation greeting for a bound Maurice. The persona creator lives in
// PersonaCreatorView.swift.

/// Shared UI state for the Studio: the "current Maurice" filter anchor, the
/// SHOW ALL toggle, and which sheet (picker / creator) is open.
@Observable @MainActor
final class StudioState {
    /// Tracks a recently-touched Maurice (used by the persona creator/delete);
    /// no longer drives any list filter.
    var currentMauriceId: String?
    var showPicker = false

    /// Raised by the picker's "Send" once it has armed the chosen Maurice — the
    /// composer observes this and fires its current draft. A one-shot flag the
    /// composer flips back to false.
    var pendingSend = false

    /// How the picker was opened: from the composer's ➤ long-press (a draft is
    /// waiting, so picking sends → the row reads "Send") vs. the empty-composer
    /// chooser tap (picking just arms the Maurice → the row reads "Use").
    var pickerSends = false

    /// The persona being created/edited; nil = creator closed.
    var draft: Maurice?
    var draftIsEdit = false

    func openCreator(_ maurice: Maurice?, isEdit: Bool) {
        draft = maurice ?? Maurice.blank()
        draftIsEdit = isEdit
        showPicker = false
    }

    func closeCreator() { draft = nil }

    /// Back out of the editor to the Maurices list (the picker) — not all the way
    /// out to the chat. Re-present the picker once the editor's dismissal has
    /// settled (you can't present a sheet while another is mid-dismiss).
    func backToList() {
        draft = nil
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(0.35))
            showPicker = true
        }
    }
}

// MARK: - Creativity / pills helpers

/// Maps a 0…1 temperature to the design's label.
func creativityLabel(_ temp: Double) -> String {
    if temp <= 0.3 { return L("persona.creativity.precise") }
    if temp >= 0.75 { return L("persona.creativity.creative") }
    return L("persona.creativity.balanced")
}

/// A small mono pill used in greetings and previews.
struct StudioPill: View {
    @Environment(\.mauriceTheme) private var theme
    let icon: String
    let text: String
    var tint: Color? = nil

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: icon).font(.system(size: 9))
            Text(text).font(.system(size: 10, design: .monospaced))
        }
        .foregroundStyle(tint ?? theme.inkSoft)
        .padding(.horizontal, 9).padding(.vertical, 5)
        .overlay(Capsule().strokeBorder(theme.ruleHard, lineWidth: 0.5))
    }
}

// MARK: - Picker (start a conversation with a Maurice)

struct MauricePicker: View {
    @Environment(MauriceStore.self) private var store
    @Environment(StudioState.self) private var studio
    @Environment(ChatService.self) private var chat
    @Environment(\.mauriceTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    /// Called after a conversation is started, so the compact layout can slide
    /// from the sidebar to the chat.
    var onActivate: () -> Void = {}

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    // The everyday Maurice is always offered first — no hat, no
                    // access gate, just a plain new conversation.
                    ForEach([Maurice.everyday] + store.usableMaurices) { m in
                        PickerRow(
                            maurice: m,
                            startLabel: studio.pickerSends ? L("studio.send") : L("studio.use"),
                            onStart: { pick(m) },
                            onEdit: { studio.openCreator(m, isEdit: true) }
                        )
                    }

                    // Create a new Maurice
                    Button { studio.openCreator(nil, isEdit: false) } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "plus").font(.system(size: 13))
                            Text(L("studio.create_new_maurice")).font(.system(size: 14))
                            Spacer()
                        }
                        .foregroundStyle(theme.inkSoft)
                        .padding(.horizontal, 14).padding(.vertical, 16)
                        .frame(maxWidth: .infinity)
                        .overlay(RoundedRectangle(cornerRadius: 12)
                            .strokeBorder(theme.ruleHard, style: StrokeStyle(lineWidth: 0.5, dash: [4, 4])))
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 4)
                }
                .padding(18)
            }
            .background(theme.surface)
            .navigationTitle(L("studio.start_conversation"))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L("common.done")) { dismiss() }.tint(theme.ink)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 520, idealWidth: 560, minHeight: 520, idealHeight: 640)
        #endif
    }

    private func pick(_ m: Maurice) {
        // Content-first: arm this Maurice (everyday = nil). If a draft is waiting
        // (opened via the ➤ long-press), let the composer fire it at them — the
        // first send persists the choice as the default for new conversations.
        // Otherwise (empty-composer chooser) we just arm them.
        chat.currentMauriceId = m.isEveryday ? nil : m.rawId
        dismiss()
        onActivate()
        if studio.pickerSends { studio.pendingSend = true }
    }
}

private struct PickerRow: View {
    @Environment(MauriceStore.self) private var store
    @Environment(\.mauriceTheme) private var theme
    let maurice: Maurice
    let startLabel: String
    let onStart: () -> Void
    let onEdit: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            // The everyday Maurice carries no hat — its row is ragged-left, just
            // like everyday conversations in the sidebar.
            if !maurice.isEveryday {
                HatBadge(kind: maurice.hat, palette: maurice.paletteValue, size: 44)
            }

            VStack(alignment: .leading, spacing: 3) {
                Text(maurice.name)
                    .font(.system(size: 16, design: .serif))
                    .foregroundStyle(theme.ink)
                if !maurice.tagline.isEmpty {
                    Text(maurice.tagline)
                        .font(.system(size: 12))
                        .foregroundStyle(theme.inkSoft)
                        .lineLimit(1)
                }
                Text(maurice.isEveryday
                     ? store.modelName(for: maurice)
                     : "\(store.modelName(for: maurice)) · ~\(fmtTok(maurice.weight))")
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundStyle(theme.inkMute)
            }

            Spacer(minLength: 6)

            // The everyday Maurice can't be edited.
            if !maurice.isEveryday {
                Button(action: onEdit) {
                    Image(systemName: "pencil").font(.system(size: 13))
                        .foregroundStyle(theme.inkMute)
                        .frame(width: 30, height: 30)
                }
                .buttonStyle(.plain)
                .help(L("studio.edit_this_maurice"))
            }

            Button(action: onStart) {
                Text(startLabel)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14).padding(.vertical, 7)
                    .background(maurice.paletteValue.bg)
                    .clipShape(Capsule())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 12).fill(theme.bg))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(theme.ruleHard, lineWidth: 0.5))
    }
}

// MARK: - Conversation greeting for a bound Maurice

/// The empty-state greeting shown when a conversation uses a specialized
/// Maurice: large hat badge, the Maurice's name + tagline, model / context /
/// creativity pills, and an "Edit Maurice" affordance.
struct StudioGreeting: View {
    @Environment(MauriceStore.self) private var store
    @Environment(StudioState.self) private var studio
    @Environment(\.mauriceTheme) private var theme
    let maurice: Maurice

    var body: some View {
        VStack(spacing: 16) {
            Spacer()

            HatBadge(kind: maurice.hat, palette: maurice.paletteValue, size: 72)

            Text(maurice.name)
                .font(.system(size: 30, design: .serif))
                .foregroundStyle(theme.ink)
                .multilineTextAlignment(.center)

            if !maurice.tagline.isEmpty {
                Text(maurice.tagline)
                    .font(.system(size: 14))
                    .foregroundStyle(theme.inkSoft)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 48)
            }

            FlowLayout(spacing: 8) {
                StudioPill(icon: store.model(for: maurice.model)?.isLocal == true ? "lock.shield" : "cloud",
                           text: store.modelName(for: maurice))
                if maurice.count > 0 {
                    StudioPill(icon: "doc.text",
                               text: "\(String(format: maurice.count == 1 ? L("studio.source_count_one") : L("studio.source_count_other"), maurice.count)) · ~\(fmtTok(maurice.weight))")
                }
                StudioPill(icon: "dial.medium", text: creativityLabel(maurice.temp))
            }
            .fixedSize(horizontal: true, vertical: false)

            Button { studio.openCreator(maurice, isEdit: true) } label: {
                HStack(spacing: 6) {
                    Image(systemName: "pencil").font(.system(size: 11))
                    Text(L("studio.edit_maurice")).font(.system(size: 11, design: .monospaced))
                }
                .foregroundStyle(theme.inkMute)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .overlay(Capsule().strokeBorder(theme.ruleHard, lineWidth: 0.5))
            }
            .buttonStyle(.plain)
            .padding(.top, 2)

            Spacer()
        }
        .frame(maxWidth: .infinity)
    }
}
