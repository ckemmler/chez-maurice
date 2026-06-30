import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

// MARK: - Persona Creator
//
// Full-screen form to build or edit a specialized Maurice, with a live preview.
// On a regular-width window the preview is pinned in a right rail; on compact it
// sits at the top of the scroll. Every control tints to the chosen palette
// colour (accent = palette.bg), so the form re-themes as the hat colour changes.

struct PersonaCreator: View {
    @Environment(MauriceStore.self) private var store
    @Environment(StudioState.self) private var studio
    @Environment(ChatService.self) private var chat
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var hSize
    #endif

    @State private var draft: Maurice
    @State private var ctx: ComposerStore
    @State private var isEdit: Bool
    @State private var showAddContext = false
    @State private var saving = false
    @State private var confirmDelete = false

    /// Tracks which text field holds the keyboard, so the keyboard accessory
    /// "hide" button can resign it (the system keyboard can't host a custom key).
    private enum Field { case name, tagline, prompt }
    @FocusState private var focus: Field?

    init(draft: Maurice, isEdit: Bool, session: SessionStore) {
        _draft = State(initialValue: draft)
        _isEdit = State(initialValue: isEdit)
        _ctx = State(initialValue: ComposerStore(session: session))
    }

    private var accent: Color { HatPalette.by(draft.palette).bg }
    private var canSave: Bool { !draft.name.trimmingCharacters(in: .whitespaces).isEmpty && !saving }
    /// Muted terracotta for destructive actions (matches the app's warm palette).
    private let deleteTint = Color(hex: "a6452e")

    // The two-column (form + pinned preview) layout is for roomy iPad windows
    // only. macOS uses the single-column layout — same as iPhone — in a sized
    // sheet; the split version was cramped.
    private var isRegular: Bool {
        #if os(iOS)
        return hSize == .regular
        #else
        return false
        #endif
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(theme.rule)

            if isRegular {
                HStack(alignment: .top, spacing: 0) {
                    formScroll
                    Divider().overlay(theme.rule)
                    ScrollView { PersonaPreview(draft: draft, weight: ctx.total, count: ctx.items.count).padding(20) }
                        .frame(width: 360)
                        .background(theme.surfaceAlt)
                }
            } else {
                ScrollView {
                    VStack(spacing: 24) {
                        PersonaPreview(draft: draft, weight: ctx.total, count: ctx.items.count)
                        formSections
                    }
                    .padding(18)
                }
                .scrollDismissesKeyboard(.interactively)
            }
        }
        .background(theme.surface)
        #if os(macOS)
        // A single-column sheet needs an explicit size on macOS (it won't grow to
        // fill the screen the way fullScreenCover does on iOS).
        .frame(minWidth: 460, idealWidth: 520, minHeight: 560, idealHeight: 760)
        #endif
        #if os(iOS)
        // A "hide keyboard" control attached to the keyboard (the system keyboard
        // itself can't host a custom key), mirroring the chat composer — so the
        // keyboard never blocks the hat/colour pickers below the fields.
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button { focus = nil } label: {
                    Image(systemName: "keyboard.chevron.compact.down")
                }
                .tint(theme.inkSoft)
            }
        }
        #endif
        .task {
            ctx.items = draft.contextItems
            await ctx.reweigh()
            // Default a fresh Maurice to the Garden · Notes tool (web + signals
            // are always on); the user adjusts from there.
            if draft.toolFamilies == nil { draft.toolFamilies = ["garden-notes"] }
            if store.families.isEmpty { await store.loadFamilies() }
        }
        .sheet(isPresented: $showAddContext) {
            #if os(iOS)
            AddContextSheet(accent: accent)
                .environment(ctx)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
            #else
            AddContextSheet(accent: accent).environment(ctx)
            #endif
        }
        .alert(session.localized("persona.delete.title") + " “\(draft.name)”?", isPresented: $confirmDelete) {
            Button(session.localized("persona.delete.confirm"), role: .destructive) { deleteMaurice() }
            Button(session.localized("common.cancel"), role: .cancel) {}
        } message: {
            Text(session.localized("persona.delete.message"))
        }
    }

    // MARK: header

    private var header: some View {
        HStack(spacing: 14) {
            Button { studio.backToList() } label: {
                Image(systemName: "chevron.left").font(.system(size: 15, weight: .medium))
                    .foregroundStyle(theme.ink)
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 2) {
                Text(isEdit ? session.localized("persona.header.edit") : session.localized("persona.header.new"))
                    .font(.system(size: 9, design: .monospaced)).tracking(0.8)
                    .foregroundStyle(theme.inkMute)
                Text(draft.name.isEmpty ? session.localized("persona.header.untitled") : draft.name)
                    .font(.system(size: 18, design: .serif))
                    .foregroundStyle(draft.name.isEmpty ? theme.inkMute : theme.ink)
                    .lineLimit(1)
            }

            Spacer()

            if isEdit {
                Button(role: .destructive) { confirmDelete = true } label: {
                    Image(systemName: "trash").font(.system(size: 16))
                        .foregroundStyle(deleteTint)
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.plain)
                .disabled(saving)
                .help(session.localized("persona.delete.help"))
            }

            Button { save() } label: {
                Text(isEdit ? session.localized("common.save") : session.localized("common.create"))
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 18).padding(.vertical, 8)
                    .background(canSave ? accent : theme.inkMute.opacity(0.4))
                    .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(!canSave)
        }
        .padding(.horizontal, 18).padding(.vertical, 12)
    }

    private var formScroll: some View {
        ScrollView {
            formSections.padding(24).frame(maxWidth: 560, alignment: .leading)
        }
        .frame(maxWidth: .infinity)
        .scrollDismissesKeyboard(.interactively)
    }

    @ViewBuilder
    private var formSections: some View {
        VStack(alignment: .leading, spacing: 28) {
            identitySection
            modelSection
            instructionsSection
            contextSection
            toolsSection
        }
        .padding(.bottom, 24)
    }

    // MARK: 1 · Identity

    private var identitySection: some View {
        Section(number: 1, title: session.localized("persona.section.identity"), theme: theme) {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 14) {
                    HatBadge(kind: draft.hat, palette: HatPalette.by(draft.palette), size: 60)
                    VStack(alignment: .leading, spacing: 8) {
                        TextField(session.localized("persona.field.name"), text: $draft.name)
                            .textFieldStyle(.plain)
                            .font(.system(size: 20, design: .serif))
                            .foregroundStyle(theme.ink)
                            .focused($focus, equals: .name)
                            .submitLabel(.next)
                            .onSubmit { focus = .tagline }
                        TextField(session.localized("persona.field.tagline"), text: $draft.tagline)
                            .textFieldStyle(.plain)
                            .font(.system(size: 13))
                            .foregroundStyle(theme.inkSoft)
                            .focused($focus, equals: .tagline)
                    }
                }
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 10).fill(theme.bg))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(theme.rule, lineWidth: 0.5))

                // Hat picker
                fieldLabel(session.localized("persona.field.hat"))
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 6), spacing: 8) {
                    ForEach(HAT_KINDS, id: \.0) { kind, label in
                        let on = draft.hat == kind
                        Button { draft.hat = kind } label: {
                            HatBadge(kind: kind, palette: HatPalette.by(draft.palette), size: 40)
                                .overlay(RoundedRectangle(cornerRadius: 40 * 0.28, style: .continuous)
                                    .strokeBorder(on ? accent : Color.clear, lineWidth: 2))
                                .padding(2)
                        }
                        .buttonStyle(.plain)
                        .help(label)
                    }
                }

                // Palette picker
                fieldLabel(session.localized("persona.field.color"))
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 5), spacing: 8) {
                    ForEach(HatPalette.all) { p in
                        let on = draft.palette == p.id
                        Button { draft.palette = p.id } label: {
                            HatBadge(kind: draft.hat, palette: p, size: 40)
                                .overlay(RoundedRectangle(cornerRadius: 40 * 0.28, style: .continuous)
                                    .strokeBorder(on ? theme.ink : Color.clear, lineWidth: 2))
                                .padding(2)
                        }
                        .buttonStyle(.plain)
                        .help(p.label)
                    }
                }
            }
        }
    }

    // MARK: 2 · Model

    private static let providerOrder = ["anthropic", "openai", "mistral", "ollama"]

    private var modelSection: some View {
        Section(number: 2, title: session.localized("persona.section.model"), theme: theme) {
            let available = store.models.filter { $0.available }
            let selectedId = draft.model ?? available.first?.id
            // Group by provider, in a stable order, then any unknown providers.
            let known = Set(Self.providerOrder)
            let ordered = Self.providerOrder.compactMap { p -> (String, [MauriceModel])? in
                let ms = available.filter { $0.provider == p }
                return ms.isEmpty ? nil : (p, ms)
            }
            let extra = available.filter { !known.contains($0.provider) }
            let extraGroups = Dictionary(grouping: extra, by: \.provider)
                .map { ($0.key, $0.value) }.sorted { $0.0 < $1.0 }
            let groups = ordered + extraGroups
            VStack(alignment: .leading, spacing: 18) {
                ForEach(groups, id: \.0) { provider, models in
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 8) {
                            ProviderBadge(provider: provider, size: 20)
                            Text(ProviderStyle.name(provider))
                                .font(.system(size: 10, design: .monospaced)).tracking(0.8)
                                .foregroundStyle(theme.inkSoft)
                            Spacer()
                        }
                        ForEach(models) { m in
                            ModelCard(model: m, selected: m.id == selectedId, accent: accent) {
                                draft.model = m.id
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: 3 · Instructions

    private var instructionsSection: some View {
        Section(number: 3, title: session.localized("persona.section.instructions"), theme: theme) {
            VStack(alignment: .leading, spacing: 14) {
                TextEditor(text: $draft.prompt)
                    .font(.system(size: 13.5))
                    .foregroundStyle(theme.ink)
                    .focused($focus, equals: .prompt)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 120)
                    .padding(10)
                    .background(RoundedRectangle(cornerRadius: 10).fill(theme.bg))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(theme.rule, lineWidth: 0.5))
                    .overlay(alignment: .topLeading) {
                        if draft.prompt.isEmpty {
                            Text(session.localized("persona.instructions.placeholder"))
                                .font(.system(size: 13.5)).foregroundStyle(theme.inkMute)
                                .padding(.horizontal, 15).padding(.vertical, 18)
                                .allowsHitTesting(false)
                        }
                    }

                HStack {
                    fieldLabel(session.localized("persona.field.creativity"))
                    Spacer()
                    Text(creativityLabel(draft.temp))
                        .font(.system(size: 10.5, design: .monospaced)).foregroundStyle(accent.legible(onDark: theme.isDark))
                }
                Slider(value: $draft.temp, in: 0...1, step: 0.05).tint(accent.legible(onDark: theme.isDark))
                HStack {
                    Text(session.localized("persona.creativity.precise")).font(.system(size: 9, design: .monospaced)).foregroundStyle(theme.inkMute)
                    Spacer()
                    Text(session.localized("persona.creativity.balanced")).font(.system(size: 9, design: .monospaced)).foregroundStyle(theme.inkMute)
                    Spacer()
                    Text(session.localized("persona.creativity.creative")).font(.system(size: 9, design: .monospaced)).foregroundStyle(theme.inkMute)
                }
            }
        }
    }

    // MARK: 4 · Context

    private var contextSection: some View {
        Section(number: 4, title: session.localized("persona.section.context"), theme: theme) {
            VStack(alignment: .leading, spacing: 8) {
                Text(session.localized("persona.context.description"))
                    .font(.system(size: 11)).foregroundStyle(theme.inkSoft)
                ContextTray(accent: accent, onAddMore: { showAddContext = true })
                    .environment(ctx)
            }
        }
    }

    // MARK: 5 · Tools

    private var modelIsLocal: Bool {
        let id = draft.model ?? store.models.first?.id
        return store.models.first { $0.id == id }?.isLocal ?? false
    }

    private var toolsSection: some View {
        Section(number: 5, title: session.localized("persona.section.tools"), theme: theme) {
            VStack(alignment: .leading, spacing: 12) {
                if modelIsLocal {
                    Text(session.localized("persona.tools.local_hint"))
                        .font(.system(size: 10.5)).foregroundStyle(theme.inkMute)
                }
                ToolFamilyPicker(
                    families: store.families,
                    selected: Binding(
                        get: { Set(draft.toolFamilies ?? ["garden-notes"]) },
                        set: { draft.toolFamilies = Array($0) }
                    ),
                    accent: accent
                )
            }
        }
    }

    private func fieldLabel(_ text: String) -> some View {
        Text(text).font(.system(size: 9, design: .monospaced)).tracking(0.8)
            .foregroundStyle(theme.inkMute)
    }

    private func save() {
        saving = true
        draft.contextItems = ctx.items
        Task {
            _ = await store.save(draft)
            saving = false
            studio.closeCreator()
        }
    }

    private func deleteMaurice() {
        guard let id = draft.rawId else { return }
        saving = true
        Task {
            await store.delete(id)
            // Drop the filter anchor if it pointed here, then refresh the
            // conversation list (the server has nulled its bound conversations).
            if studio.currentMauriceId == id { studio.currentMauriceId = nil }
            await chat.loadConversations()
            saving = false
            studio.closeCreator()
        }
    }
}

// MARK: - Section scaffold

private struct Section<Content: View>: View {
    let number: Int
    let title: String
    let theme: MauriceTheme
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Text("\(number)")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(theme.inkMute)
                    .frame(width: 18, height: 18)
                    .overlay(Circle().strokeBorder(theme.ruleHard, lineWidth: 0.5))
                Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(theme.ink)
            }
            content()
        }
    }
}

// MARK: - Model card

// MARK: - Provider identity (logo badge + label)

enum ProviderStyle {
    static func color(_ p: String) -> Color {
        switch p {
        case "anthropic":         return Color(hex: "cc785c") // clay
        case "openai":            return Color(hex: "202123") // near-black
        case "mistral":           return Color(hex: "fa500f") // orange
        case "gemini", "google":  return Color(hex: "4d83ef") // blue
        case "ollama":            return Color(hex: "00ff00") // pure green — local/on-device
        default:                  return Color(hex: "6b6460")
        }
    }
    /// Brand mark fill for the composer model pill — gradients for Mistral &
    /// Gemini, solids for Anthropic & OpenAI (the household's provider palette).
    static func fill(_ p: String) -> AnyShapeStyle {
        func grad(_ a: String, _ b: String) -> AnyShapeStyle {
            AnyShapeStyle(LinearGradient(
                colors: [Color(hex: a), Color(hex: b)],
                startPoint: .topLeading, endPoint: .bottomTrailing))
        }
        switch p {
        case "anthropic":         return AnyShapeStyle(Color(hex: "da7758"))
        case "openai":            return AnyShapeStyle(Color(hex: "202123"))
        case "mistral":           return grad("fcc73c", "fc6817")
        case "gemini", "google":  return grad("4d83ef", "cd6983")
        default:                  return AnyShapeStyle(color(p))
        }
    }
    static func symbol(_ p: String) -> String {
        switch p {
        case "anthropic":         return "asterisk"
        case "openai":            return "circle.hexagongrid.fill"
        case "mistral":           return "wind"
        case "gemini", "google":  return "sparkle"
        case "ollama":            return "cpu"
        default:                  return "cube"
        }
    }
    static func name(_ p: String) -> String {
        switch p {
        case "anthropic":         return "ANTHROPIC"
        case "openai":            return "OPENAI"
        case "mistral":           return "MISTRAL"
        case "gemini", "google":  return "GEMINI"
        case "ollama":            return L("persona.provider.ollama")
        default:                  return p.uppercased()
        }
    }
    /// Real logo asset (Assets.xcassets → "logo-<provider>"), if it's been added.
    static func logoAsset(_ p: String) -> String? {
        let name = "logo-\(p)"
        #if canImport(UIKit)
        return UIImage(named: name) != nil ? name : nil
        #elseif canImport(AppKit)
        return NSImage(named: name) != nil ? name : nil
        #else
        return nil
        #endif
    }
}

/// Provider chip: the real logo (its own colours) on a light ground so both the
/// black marks (Anthropic, OpenAI) and the colour marks (Mistral, Gemini) read —
/// falling back to a brand-coloured SF Symbol chip until a logo asset is added.
struct ProviderBadge: View {
    let provider: String
    var size: CGFloat = 20
    var body: some View {
        let r = size * 0.28
        if let asset = ProviderStyle.logoAsset(provider) {
            Image(asset)
                .resizable()
                .scaledToFit()
                .padding(size * 0.16)
                .frame(width: size, height: size)
                .background(RoundedRectangle(cornerRadius: r, style: .continuous).fill(.white))
                .overlay(RoundedRectangle(cornerRadius: r, style: .continuous)
                    .strokeBorder(.black.opacity(0.08), lineWidth: 0.5))
        } else {
            Image(systemName: ProviderStyle.symbol(provider))
                .font(.system(size: size * 0.55, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: size, height: size)
                .background(RoundedRectangle(cornerRadius: r, style: .continuous)
                    .fill(ProviderStyle.color(provider)))
        }
    }
}

private struct ModelCard: View {
    @Environment(\.mauriceTheme) private var theme
    @Environment(SessionStore.self) private var session
    let model: MauriceModel
    let selected: Bool
    let accent: Color
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .top, spacing: 12) {
                Circle()
                    .fill(selected ? accent : Color.clear)
                    .frame(width: 16, height: 16)
                    .overlay(Circle().strokeBorder(selected ? accent : theme.ruleHard, lineWidth: 1.5))
                    .overlay { if selected { Circle().fill(.white).frame(width: 5, height: 5) } }
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                        Text(model.name).font(.system(size: 14, weight: .medium)).foregroundStyle(theme.ink)
                        Text(model.isLocal ? session.localized("model.ondevice") : session.localized("model.cloud"))
                            .font(.system(size: 8.5, design: .monospaced)).tracking(0.5)
                            .padding(.horizontal, 5).padding(.vertical, 1.5)
                            .foregroundStyle(theme.inkSoft)
                            .overlay(Capsule().strokeBorder(theme.ruleHard, lineWidth: 0.5))
                    }
                    Text(model.desc).font(.system(size: 11.5)).foregroundStyle(theme.inkSoft)
                    Text(model.sub).font(.system(size: 9.5, design: .monospaced)).foregroundStyle(theme.inkMute)
                }
                Spacer()
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 10).fill(selected ? accent.opacity(0.08) : theme.bg))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(selected ? accent : theme.rule, lineWidth: selected ? 1 : 0.5))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Tool family picker (reused by the persona creator + chat composer)

struct ToolFamilyPicker: View {
    @Environment(\.mauriceTheme) private var theme
    @Environment(SessionStore.self) private var session
    let families: [ToolFamily]
    @Binding var selected: Set<String>
    let accent: Color

    @State private var showExperimental = false
    private let cols = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]

    private var alwaysOn: [ToolFamily] { families.filter(\.alwaysOn) }
    private var garden: [ToolFamily] {
        families.filter { $0.group == "garden" }
            .sorted { ($0.id == "garden-notes" ? 0 : 1, -$0.count) < ($1.id == "garden-notes" ? 0 : 1, -$1.count) }
    }
    private var experimental: [ToolFamily] {
        families.filter { $0.group == "experimental" }.sorted { $0.count > $1.count }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if !alwaysOn.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "bolt.fill").font(.system(size: 9)).foregroundStyle(Color(hex: "3d6b4f").legible(onDark: theme.isDark))
                    Text(session.localized("tools.always_on", alwaysOn.map(\.title).joined(separator: " · ")))
                        .font(.system(size: 10.5, design: .monospaced)).foregroundStyle(theme.inkMute)
                }
            }

            if !garden.isEmpty { section(session.localized("tools.section.garden"), garden) }

            if !experimental.isEmpty {
                DisclosureGroup(isExpanded: $showExperimental) {
                    grid(experimental).padding(.top, 8)
                } label: {
                    Text(session.localized("tools.section.experimental", experimental.count))
                        .font(.system(size: 9, design: .monospaced)).tracking(0.8)
                        .foregroundStyle(theme.inkMute)
                }
                .tint(theme.inkSoft)
            }
        }
    }

    @ViewBuilder private func section(_ title: String, _ items: [ToolFamily]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title.uppercased())
                .font(.system(size: 9, design: .monospaced)).tracking(0.8).foregroundStyle(theme.inkMute)
            grid(items)
        }
    }

    private func grid(_ items: [ToolFamily]) -> some View {
        LazyVGrid(columns: cols, spacing: 8) {
            ForEach(items) { f in
                let on = selected.contains(f.id)
                Button {
                    if on { selected.remove(f.id) } else { selected.insert(f.id) }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: f.icon)
                            .font(.system(size: 13)).frame(width: 18)
                            .foregroundStyle(on ? accent : theme.inkMute)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(f.title).font(.system(size: 12.5, weight: .medium))
                                .foregroundStyle(theme.ink).lineLimit(1)
                            Text(f.count == 1 ? session.localized("tools.count.one", f.count) : session.localized("tools.count.other", f.count))
                                .font(.system(size: 9, design: .monospaced)).foregroundStyle(theme.inkMute)
                        }
                        Spacer(minLength: 0)
                        if on {
                            Image(systemName: "checkmark")
                                .font(.system(size: 10, weight: .bold)).foregroundStyle(accent.legible(onDark: theme.isDark))
                        }
                    }
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 9).fill(on ? accent.opacity(0.10) : theme.bg))
                    .overlay(RoundedRectangle(cornerRadius: 9)
                        .strokeBorder(on ? accent.opacity(0.5) : theme.rule, lineWidth: on ? 1 : 0.5))
                }
                .buttonStyle(.plain)
            }
        }
    }
}

// MARK: - Live preview

struct PersonaPreview: View {
    @Environment(MauriceStore.self) private var store
    @Environment(\.mauriceTheme) private var theme
    @Environment(SessionStore.self) private var session
    let draft: Maurice
    let weight: Int
    let count: Int

    private var palette: HatPalette { HatPalette.by(draft.palette) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Palette banner with the hat badge overlapping it
            palette.bg
                .frame(height: 56)
                .overlay(alignment: .bottomLeading) {
                    HatBadge(kind: draft.hat, palette: palette, size: 56)
                        .overlay(RoundedRectangle(cornerRadius: 56 * 0.28, style: .continuous)
                            .strokeBorder(theme.surface, lineWidth: 2))
                        .offset(x: 16, y: 28)
                }

            VStack(alignment: .leading, spacing: 10) {
                Spacer().frame(height: 26)
                Text(draft.name.isEmpty ? session.localized("persona.preview.untitled") : draft.name)
                    .font(.system(size: 19, design: .serif))
                    .foregroundStyle(draft.name.isEmpty ? theme.inkMute : theme.ink)
                Text(draft.tagline.isEmpty ? excerpt(draft.prompt) : draft.tagline)
                    .font(.system(size: 12))
                    .foregroundStyle(theme.inkSoft)
                    .lineLimit(3)

                Divider().overlay(theme.rule).padding(.vertical, 2)

                previewRow(session.localized("persona.preview.model"), store.modelName(for: draft))
                previewRow(session.localized("persona.preview.context"), count == 0 ? session.localized("persona.preview.none") : (count == 1 ? session.localized("persona.preview.sources.one", count, fmtTok(weight)) : session.localized("persona.preview.sources.other", count, fmtTok(weight))))
                previewRow(session.localized("persona.preview.creativity"), creativityLabel(draft.temp))
            }
            .padding(.horizontal, 16).padding(.bottom, 16)
        }
        .background(RoundedRectangle(cornerRadius: 14).fill(theme.bg))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(theme.rule, lineWidth: 0.5))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    private func excerpt(_ s: String) -> String {
        s.isEmpty ? session.localized("persona.preview.no_tagline") : String(s.prefix(120))
    }

    private func previewRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(label.uppercased())
                .font(.system(size: 9, design: .monospaced)).tracking(0.6)
                .foregroundStyle(theme.inkMute)
                .frame(width: 78, alignment: .leading)
            Text(value).font(.system(size: 12)).foregroundStyle(theme.ink)
            Spacer(minLength: 0)
        }
    }
}
