import SwiftUI
import UniformTypeIdentifiers

// MARK: - Composer UI

// Tokens for the weight tiers (terracotta / marigold), per the design.
private let CAUTION = Color(hex: "b97a1e")
private let WARN = Color(hex: "a6452e")

func fmtTok(_ n: Int) -> String {
    if n >= 1000 {
        let k = Double(n) / 1000.0
        return (k >= 100 ? String(Int(k.rounded())) : String(format: "%.1f", k)) + "k"
    }
    return String(n)
}

func tierColor(_ total: Int, _ theme: MauriceTheme) -> Color {
    let f = Double(total) / Double(CTX_BUDGET)
    if f >= 1 { return WARN.legible(onDark: theme.isDark) }
    if f >= 0.55 { return CAUTION.legible(onDark: theme.isDark) }
    if f >= 0.18 { return theme.inkSoft }
    return theme.inkMute
}

private func typeSymbol(_ type: ComposerItemType, moc: Bool, kind: String = "") -> String {
    switch type {
    case .note: return moc ? "rectangle.3.group" : "note.text"
    case .book: return "book"
    case .conversation: return "bubble.left.and.bubble.right"
    case .folder: return "folder"
    case .file:
        switch kind {
        case "img": return "photo"
        case "pdf": return "doc.richtext"
        case "text": return "doc.text"
        default: return "doc"
        }
    }
}

// Compact mono phrase for a book's current representation + scope, e.g.
// "all chapters · summaries", "up to ch. 6 · full text".
private func bookScopeLabel(_ item: TrayItem) -> String {
    let rep = item.representation == "full" ? L("book.representation.fullText") : L("book.representation.summaries")
    let scope: String
    switch item.scopeMode {
    case "up_to":    scope = String(format: L("book.scope.upToChapter"), item.uptoChapter + 1)
    case "chapters": scope = item.selectedRefs.count == 1 ? L("book.scope.oneChapter") : String(format: L("book.scope.nChapters"), item.selectedRefs.count)
    default:         scope = L("book.scope.allChapters")
    }
    return "\(scope) · \(rep)"
}

// The mono meta subline shown under a card title.
private func cardMeta(_ item: TrayItem, count: Int) -> String {
    switch item.type {
    case .note:
        let hasChildren = item.sub.contains("fans out") || item.moc
        if !hasChildren { return L("note.meta.singleNote") }
        return item.recurse ? String(format: L("note.meta.withDescendants"), count) : L("note.meta.descendantsOff")
    case .book:
        let author = item.sub.isEmpty ? "" : item.sub + " · "
        return author + bookScopeLabel(item)
    case .conversation:
        return item.sub.isEmpty ? L("context.conversation") : item.sub
    case .file:
        // kind · path (· size when search-supplied). na files note they ride along.
        return item.sub.isEmpty ? item.kind : item.sub
    case .folder:
        if !item.recurse { return L("folder.meta.directOnly") }
        return String(format: L("folder.meta.files"), count)
    }
}

#if os(iOS)
extension View {
    /// Warm translucent "glass" panel: a `theme.surface` tint over a blur,
    /// with a hairline border and soft shadow. Floats over the scrolling stream.
    func glassPanel(_ theme: MauriceTheme, cornerRadius: CGFloat) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius)
        return self
            .background(theme.surface.opacity(0.80), in: shape) // warm tint, over…
            .background(.ultraThinMaterial, in: shape)          // …the backdrop blur
            .overlay(shape.strokeBorder(theme.rule, lineWidth: 0.5))
            .shadow(color: .black.opacity(0.12), radius: 14, y: 8)
    }
}
#endif

// MARK: Weight readout (ctx <total> / 200k + meter + caption)

struct WeightReadout: View {
    let total: Int
    @Environment(\.mauriceTheme) private var theme

    private var frac: Double { Double(total) / Double(CTX_BUDGET) }
    private var caption: String? {
        if frac >= 1 { return L("weight.overBudget") }
        if frac >= 0.55 { return L("weight.heavy") }
        if frac < 0.18 { return L("weight.light") }
        return nil
    }

    var body: some View {
        let color = tierColor(total, theme)
        VStack(alignment: .trailing, spacing: 3) {
            Text(String(format: L("weight.ctxReadout"), fmtTok(total)))
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(color)
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(theme.rule)
                    Capsule().fill(color).frame(width: g.size.width * min(1, max(0.02, frac)))
                }
            }
            .frame(width: 116, height: 2)
            if let caption {
                Text(caption)
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(color)
            }
        }
    }
}

// MARK: Segmented (2–3 options) — inset track, accent-filled selection

struct ComposerSegmented: View {
    @Environment(\.mauriceTheme) private var theme
    let options: [(value: String, label: String)]
    @Binding var value: String
    let accent: Color

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.value) { opt in
                let on = value == opt.value
                Text(opt.label)
                    .font(.system(size: 12, weight: on ? .semibold : .regular))
                    .foregroundStyle(on ? .white : theme.inkSoft)
                    .padding(.vertical, 4)
                    .padding(.horizontal, 11)
                    .background(on ? accent : Color.clear) // longhand fill, no transition (design pitfall)
                    .clipShape(RoundedRectangle(cornerRadius: 5))
                    .contentShape(Rectangle())
                    .onTapGesture { value = opt.value }
                    .accessibilityAddTraits(.isButton)
                    .accessibilityLabel(opt.label)
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: 7).fill(theme.surfaceAlt))
        .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(theme.rule, lineWidth: 0.5))
        .fixedSize(horizontal: true, vertical: false)
    }
}

// MARK: Small switch matching the design's compact proportions

private struct ComposerSwitch: View {
    @Environment(\.mauriceTheme) private var theme
    let on: Bool
    var tint: Color
    let toggle: () -> Void

    var body: some View {
        ZStack(alignment: on ? .trailing : .leading) {
            Capsule().fill(on ? tint : theme.ruleHard)
                .frame(width: 30, height: 17)
            Circle().fill(.white)
                .frame(width: 13, height: 13)
                .shadow(color: .black.opacity(0.3), radius: 0.5, y: 0.5)
                .padding(.horizontal, 2)
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: toggle)
    }
}

// MARK: Compact chip (chips mode)

struct CompactChip: View {
    @Environment(\.mauriceTheme) private var theme
    let item: TrayItem
    let accent: Color
    let weight: Int
    let count: Int?
    let heavy: Bool
    let onRemove: () -> Void
    let onOpen: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: typeSymbol(item.type, moc: item.moc))
                .font(.system(size: 11))
                .foregroundStyle(accent.legible(onDark: theme.isDark))
            Text(item.title)
                .font(.system(size: 12))
                .foregroundStyle(theme.ink)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: 132, alignment: .leading) // keep weight + ✕ on screen
            if let count, count > 1 { Text("+\(count - 1)").font(.system(size: 10, design: .monospaced)).foregroundStyle(theme.inkMute) }
            if item.encrypted { Image(systemName: "lock.fill").font(.system(size: 8)).foregroundStyle(theme.inkMute) }
            if heavy { Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 8)).foregroundStyle(CAUTION) }
            Text("~\(fmtTok(weight))").font(.system(size: 10, design: .monospaced)).foregroundStyle(tierColor(weight, theme))
            Button(action: onRemove) { Image(systemName: "xmark").font(.system(size: 8, weight: .bold)) }
                .buttonStyle(.plain).foregroundStyle(theme.inkMute)
        }
        .padding(.leading, 8)
        .padding(.trailing, 6)
        .padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 6).fill(theme.bg))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(theme.ruleHard, lineWidth: 0.5))
        .contentShape(Rectangle())
        .onTapGesture(perform: onOpen)
    }
}

// MARK: Tray card (cards mode)

struct TrayCard: View {
    @Environment(\.mauriceTheme) private var theme
    @Environment(ComposerStore.self) private var store
    let item: TrayItem
    let accent: Color
    @Binding var openId: String?

    private var weight: Int { store.weightById[item.id] ?? 0 }
    private var count: Int { store.countById[item.id] ?? 1 }
    private var heavy: Bool { store.heavyById[item.id] ?? false }
    private var isOpen: Bool { openId == item.id }
    // Accordion: when another card is open, this one collapses to a fine line.
    private var condensed: Bool { openId != nil && openId != item.id }
    // Conversations and single files are leaves — nothing to expand.
    private var expandable: Bool { item.type != .conversation && item.type != .file }

    private var radius: CGFloat { condensed ? 7 : 9 }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if condensed { condensedHeader } else { fullHeader }
            if isOpen {
                Rectangle().fill(theme.rule).frame(height: 0.5)
                body(for: item.type)
                    .padding(.horizontal, 12)
                    .padding(.top, 4)
                    .padding(.bottom, 12)
            }
        }
        .background(RoundedRectangle(cornerRadius: radius).fill(theme.bg))
        .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(condensed ? theme.rule : theme.ruleHard, lineWidth: 0.5))
    }

    private func toggleOpen() { if expandable { openId = isOpen ? nil : item.id } }

    // Full header — chevron · glyph · title+badges / meta · weight · ✕
    private var fullHeader: some View {
        HStack(spacing: 6) {
            disclosure(content: fullHeaderContent)
            removeButton(size: 14)
        }
        .padding(.leading, 11).padding(.trailing, 10).padding(.vertical, 9)
    }

    private var fullHeaderContent: some View {
        HStack(spacing: 9) {
            if expandable {
                Image(systemName: isOpen ? "chevron.down" : "chevron.right")
                    .font(.system(size: 9)).foregroundStyle(theme.inkMute).frame(width: 10)
            } else {
                Spacer().frame(width: 12)
            }
            Image(systemName: typeSymbol(item.type, moc: item.moc, kind: item.kind)).font(.system(size: 14)).foregroundStyle(accent.legible(onDark: theme.isDark))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(item.title).font(.system(size: 13, weight: .medium)).foregroundStyle(theme.ink).lineLimit(1)
                    if item.encrypted { Image(systemName: "lock.fill").font(.system(size: 9)).foregroundStyle(theme.inkMute) }
                    if heavy { Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 9)).foregroundStyle(CAUTION) }
                }
                Text(cardMeta(item, count: count))
                    .font(.system(size: 9.5, design: .monospaced)).foregroundStyle(theme.inkMute).lineLimit(1)
            }
            Spacer(minLength: 6)
            weightLabel(size: 10)
        }
        .contentShape(Rectangle())
    }

    // Weight readout — binaries (img/pdf) have no token estimate, so they read
    // "n/a" instead of "~0"; folders that sweep in binaries show a paperclip.
    @ViewBuilder
    private func weightLabel(size: CGFloat) -> some View {
        if item.type == .file && item.na {
            Text(L("file.noEstimate")).font(.system(size: size, design: .monospaced)).foregroundStyle(theme.inkMute)
        } else {
            HStack(spacing: 3) {
                if item.type == .folder && (binaryCountById(item.id) > 0) {
                    Image(systemName: "paperclip").font(.system(size: size - 1)).foregroundStyle(theme.inkMute)
                }
                Text("~\(fmtTok(weight))").font(.system(size: size, design: .monospaced)).foregroundStyle(tierColor(weight, theme))
            }
        }
    }

    private func binaryCountById(_ id: String) -> Int { store.binaryCountById[id] ?? 0 }

    // Condensed fine-line header — title dropped, just identify + reopen.
    private var condensedHeader: some View {
        HStack(spacing: 6) {
            disclosure(content: condensedHeaderContent)
            removeButton(size: 12)
        }
        .padding(.leading, 9).padding(.trailing, 8).padding(.vertical, 2)
        .frame(minHeight: 22)
    }

    private var condensedHeaderContent: some View {
        HStack(spacing: 7) {
            if expandable {
                Image(systemName: "chevron.right")
                    .font(.system(size: 8)).foregroundStyle(theme.inkMute).frame(width: 8)
            } else {
                Spacer().frame(width: 10)
            }
            Image(systemName: typeSymbol(item.type, moc: item.moc, kind: item.kind)).font(.system(size: 11)).foregroundStyle(accent.legible(onDark: theme.isDark))
            if item.encrypted { Image(systemName: "lock.fill").font(.system(size: 8)).foregroundStyle(theme.inkMute) }
            if heavy { Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 8)).foregroundStyle(CAUTION) }
            Spacer()
            weightLabel(size: 9.5)
        }
        .contentShape(Rectangle())
    }

    // The tappable disclosure region (expand/collapse); a sibling of the remove ✕
    // so both stay independently hittable and accessible.
    @ViewBuilder
    private func disclosure(content: some View) -> some View {
        if expandable {
            Button(action: toggleOpen) { content }
                .buttonStyle(.plain)
                .accessibilityLabel(item.title)
        } else {
            content
        }
    }

    private func removeButton(size: CGFloat) -> some View {
        Button { store.remove(item.id) } label: {
            Image(systemName: "xmark").font(.system(size: size <= 12 ? 8 : 9))
        }
        .buttonStyle(.plain).foregroundStyle(theme.inkMute)
    }

    @ViewBuilder
    private func body(for type: ComposerItemType) -> some View {
        switch type {
        case .note: NoteCardBody(item: item, accent: accent)
        case .book: BookCardBody(item: item, accent: accent)
        case .folder: FolderCardBody(item: item, accent: accent)
        case .conversation, .file: EmptyView()
        }
    }
}

// MARK: Note card body — descendants switch + live tree preview

private struct NoteCardBody: View {
    @Environment(\.mauriceTheme) private var theme
    @Environment(ComposerStore.self) private var store
    let item: TrayItem
    let accent: Color
    @State private var resolved: ComposerStore.NoteResolve?

    private var excludeSet: Set<String> { Set(item.exclude) }
    private var signature: String { "\(item.recurse)|\(item.includeArchived)|\(item.exclude.sorted().joined(separator: ","))" }

    private func toggleNode(_ id: String) {
        var c = item
        if let i = c.exclude.firstIndex(of: id) { c.exclude.remove(at: i) } else { c.exclude.append(id) }
        store.update(c)
    }
    private func clearExcluded() { var c = item; c.exclude = []; store.update(c) }

    var body: some View {
        let r = resolved
        let hasChildren = r?.hasChildren ?? (item.sub.contains("fans out") || item.moc)
        let count = r?.count ?? (store.countById[item.id] ?? 1)

        VStack(alignment: .leading, spacing: 8) {
            if hasChildren {
                // Include-descendants switch
                HStack(alignment: .top, spacing: 10) {
                    ComposerSwitch(on: item.recurse, tint: accent) {
                        var c = item; c.recurse.toggle(); store.update(c)
                    }
                    .padding(.top, 1)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(L("note.includeDescendants")).font(.system(size: 12.5, weight: .medium)).foregroundStyle(theme.ink)
                        Text(item.recurse
                             ? String(format: L("note.pullsInNotes"), count) + ((r?.manualExcluded ?? 0) > 0 ? String(format: L("note.deselectedSuffix"), r!.manualExcluded) : "")
                             : L("note.justThisOne"))
                            .font(.system(size: 9.5, design: .monospaced)).foregroundStyle(theme.inkMute)
                    }
                    Spacer(minLength: 4)
                    if count >= 40 && item.recurse {
                        HStack(spacing: 4) {
                            Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 9))
                            Text(L("note.heavy")).font(.system(size: 9.5, design: .monospaced))
                        }.foregroundStyle(CAUTION)
                    }
                }

                // Include-archived switch — only when the subtree withholds archived nodes.
                if item.recurse, (r?.archivedWithheld ?? 0) > 0 || item.includeArchived {
                    HStack(spacing: 8) {
                        ComposerSwitch(on: item.includeArchived, tint: CAUTION) {
                            var c = item; c.includeArchived.toggle(); store.update(c)
                        }
                        Text(item.includeArchived
                             ? String(format: L("note.includingArchived"), r?.archivedWithheld ?? 0)
                             : String(format: L("note.includeArchived"), r?.archivedWithheld ?? 0))
                            .font(.system(size: 11.5)).foregroundStyle(theme.inkSoft)
                    }
                }

                if item.recurse, let tree = r?.tree {
                    HStack {
                        Text(L("note.tree.instructions"))
                            .font(.system(size: 8.5, design: .monospaced)).tracking(0.6)
                            .foregroundStyle(theme.inkMute).lineLimit(1).minimumScaleFactor(0.8)
                        Spacer()
                        if (r?.manualExcluded ?? 0) > 0 {
                            Button { clearExcluded() } label: {
                                Text(String(format: L("note.tree.reset"), r!.manualExcluded)).font(.system(size: 9.5, design: .monospaced)).foregroundStyle(accent.legible(onDark: theme.isDark))
                            }.buttonStyle(.plain)
                        }
                    }
                    .padding(.top, 2)
                    NoteTreePreview(root: tree, accent: accent, includeArchived: item.includeArchived,
                                    excluded: excludeSet, onToggle: toggleNode)
                } else if !item.recurse {
                    quietNote(L("note.quiet.descendantsOff"))
                }
            } else {
                quietNote(L("note.quiet.leaf"))
            }
        }
        .task(id: signature) { resolved = await store.resolveNote(item) }
    }

    private func quietNote(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 10, design: .monospaced)).foregroundStyle(theme.inkMute)
            .padding(.horizontal, 12).padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(theme.bg))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(theme.rule, lineWidth: 0.5))
    }
}

// MARK: Note tree preview (collapsible outline + per-node checkboxes)

private struct NoteTreePreview: View {
    @Environment(\.mauriceTheme) private var theme
    let root: ComposerStore.NoteTreeNode
    let accent: Color
    let includeArchived: Bool
    let excluded: Set<String>
    let onToggle: (String) -> Void
    @State private var expanded: Set<String> = []

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(flattened(), id: \.0.id) { pair in
                    row(pair.0, depth: pair.1)
                }
            }
            .padding(4)
        }
        .frame(maxHeight: 220)
        .background(RoundedRectangle(cornerRadius: 8).fill(theme.bg))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(theme.rule, lineWidth: 0.5))
        .onAppear { if expanded.isEmpty { expanded = seed() } }
    }

    // Top two levels open; deeper levels collapsed so a big subtree stays legible.
    private func seed() -> Set<String> {
        var s: Set<String> = [root.id]
        for c in root.children { s.insert(c.id); for g in c.children { s.insert(g.id) } }
        return s
    }

    private func flattened() -> [(ComposerStore.NoteTreeNode, Int)] {
        var out: [(ComposerStore.NoteTreeNode, Int)] = []
        func walk(_ n: ComposerStore.NoteTreeNode, _ d: Int) {
            out.append((n, d))
            if expanded.contains(n.id) { for c in n.children { walk(c, d + 1) } }
        }
        walk(root, 0)
        return out
    }

    @ViewBuilder
    private func row(_ node: ComposerStore.NoteTreeNode, depth: Int) -> some View {
        let isRoot = depth == 0
        let archivedGated = node.archived && !includeArchived
        let active = node.included
        let isMono = node.id.hasPrefix("bilan-") || node.id.hasPrefix("pasteboard")

        HStack(spacing: 6) {
            // checkbox
            NodeCheck(state: isRoot ? .anchor : (active ? .on : .off), accent: accent,
                      disabled: isRoot || archivedGated) {
                if !isRoot && !archivedGated { onToggle(node.id) }
            }
            // chevron or leaf dot
            if node.childCount > 0 {
                Button {
                    if expanded.contains(node.id) { expanded.remove(node.id) } else { expanded.insert(node.id) }
                } label: {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8)).foregroundStyle(theme.inkMute)
                        .rotationEffect(.degrees(expanded.contains(node.id) ? 90 : 0))
                        .frame(width: 12, height: 12)
                }.buttonStyle(.plain)
            } else {
                Circle().fill(theme.inkMute.opacity(0.5)).frame(width: 3, height: 3).frame(width: 12)
            }
            Image(systemName: node.moc ? "rectangle.3.group" : "note.text")
                .font(.system(size: 11)).foregroundStyle(node.moc ? accent : theme.inkSoft)
            Text(node.title)
                .font(.system(size: isMono ? 10.5 : 12, design: isMono ? .monospaced : .default))
                .foregroundStyle(theme.ink).lineLimit(1)
                .strikethrough(!active, color: theme.inkMute)
            if node.moc {
                Text(L("note.tree.moc")).font(.system(size: 8, design: .monospaced)).tracking(0.6)
                    .foregroundStyle(accent.legible(onDark: theme.isDark).opacity(0.8))
            }
            Spacer(minLength: 4)
            if node.archived {
                Text(includeArchived ? L("note.tree.archived") : L("note.tree.excludedBadge"))
                    .font(.system(size: 8.5, design: .monospaced)).foregroundStyle(CAUTION)
                    .padding(.horizontal, 4).padding(.vertical, 0.5)
                    .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(CAUTION.opacity(0.85), lineWidth: 0.5))
            }
            if node.encrypted { Image(systemName: "lock.fill").font(.system(size: 8)).foregroundStyle(theme.inkMute) }
        }
        .padding(.vertical, 3).padding(.horizontal, 6)
        .padding(.leading, CGFloat(depth) * 15)
        .opacity(active ? 1 : 0.5)
    }
}

private struct NodeCheck: View {
    @Environment(\.mauriceTheme) private var theme
    enum State { case on, off, anchor }
    let state: State
    let accent: Color
    let disabled: Bool
    let toggle: () -> Void

    var body: some View {
        let on = state == .on || state == .anchor
        RoundedRectangle(cornerRadius: 4)
            .fill(on ? accent : Color.clear)
            .frame(width: 14, height: 14)
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(on ? accent : theme.ruleHard, lineWidth: 1))
            .overlay {
                switch state {
                case .anchor: Circle().fill(.white).frame(width: 5, height: 5)
                case .on: Image(systemName: "checkmark").font(.system(size: 8, weight: .bold)).foregroundStyle(.white)
                case .off: EmptyView()
                }
            }
            .opacity(disabled ? (state == .anchor ? 0.7 : 0.4) : 1)
            .contentShape(Rectangle())
            .onTapGesture { if !disabled { toggle() } }
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel(on ? L("note.tree.included") : L("note.tree.excluded"))
    }
}

// MARK: Folder card body — include-contents switch + live file tree preview

private struct FolderCardBody: View {
    @Environment(\.mauriceTheme) private var theme
    @Environment(ComposerStore.self) private var store
    let item: TrayItem
    let accent: Color
    @State private var resolved: ComposerStore.FolderResolve?

    private var excludeSet: Set<String> { Set(item.exclude) }
    private var signature: String { "\(item.recurse)|\(item.exclude.sorted().joined(separator: ","))" }

    private func toggleNode(_ id: String) {
        var c = item
        if let i = c.exclude.firstIndex(of: id) { c.exclude.remove(at: i) } else { c.exclude.append(id) }
        store.update(c)
    }
    private func clearExcluded() { var c = item; c.exclude = []; store.update(c) }

    var body: some View {
        let r = resolved
        let hasChildren = r?.hasChildren ?? true
        let count = r?.count ?? (store.countById[item.id] ?? 0)
        let binaries = r?.binaryCount ?? (store.binaryCountById[item.id] ?? 0)

        VStack(alignment: .leading, spacing: 8) {
            if hasChildren {
                // Include-contents switch (recurse into subfolders).
                HStack(alignment: .top, spacing: 10) {
                    ComposerSwitch(on: item.recurse, tint: accent) {
                        var c = item; c.recurse.toggle(); store.update(c)
                    }
                    .padding(.top, 1)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(L("folder.includeContents")).font(.system(size: 12.5, weight: .medium)).foregroundStyle(theme.ink)
                        Text(item.recurse
                             ? String(format: L("folder.pullsInFiles"), count) + ((r?.manualExcluded ?? 0) > 0 ? String(format: L("note.deselectedSuffix"), r!.manualExcluded) : "")
                             : L("folder.directOnly"))
                            .font(.system(size: 9.5, design: .monospaced)).foregroundStyle(theme.inkMute)
                    }
                    Spacer(minLength: 4)
                }

                // Binaries swept in ride along as attachments (no token estimate).
                if binaries > 0 {
                    HStack(spacing: 5) {
                        Image(systemName: "paperclip").font(.system(size: 9))
                        Text(String(format: L("file.attachmentsNoEstimate"), binaries)).font(.system(size: 9.5, design: .monospaced))
                    }
                    .foregroundStyle(theme.inkMute)
                }

                if let tree = r?.tree {
                    HStack {
                        Text(L("note.tree.instructions"))
                            .font(.system(size: 8.5, design: .monospaced)).tracking(0.6)
                            .foregroundStyle(theme.inkMute).lineLimit(1).minimumScaleFactor(0.8)
                        Spacer()
                        if (r?.manualExcluded ?? 0) > 0 {
                            Button { clearExcluded() } label: {
                                Text(String(format: L("note.tree.reset"), r!.manualExcluded)).font(.system(size: 9.5, design: .monospaced)).foregroundStyle(accent.legible(onDark: theme.isDark))
                            }.buttonStyle(.plain)
                        }
                    }
                    .padding(.top, 2)
                    FileTreePreview(root: tree, accent: accent, excluded: excludeSet, onToggle: toggleNode)
                }
            } else {
                Text(L("folder.empty"))
                    .font(.system(size: 10, design: .monospaced)).foregroundStyle(theme.inkMute)
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8).fill(theme.bg))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(theme.rule, lineWidth: 0.5))
            }
        }
        .task(id: signature) { resolved = await store.resolveFolder(item) }
    }
}

// MARK: Folder file tree (collapsible outline + per-file checkboxes)

private struct FileTreePreview: View {
    @Environment(\.mauriceTheme) private var theme
    let root: ComposerStore.FileTreeNode
    let accent: Color
    let excluded: Set<String>
    let onToggle: (String) -> Void
    @State private var expanded: Set<String> = []

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(flattened(), id: \.0.id) { pair in
                    row(pair.0, depth: pair.1)
                }
            }
            .padding(4)
        }
        .frame(maxHeight: 220)
        .background(RoundedRectangle(cornerRadius: 8).fill(theme.bg))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(theme.rule, lineWidth: 0.5))
        .onAppear { if expanded.isEmpty { expanded = seed() } }
    }

    // Top two levels open; deeper folders collapsed so a big tree stays legible.
    private func seed() -> Set<String> {
        var s: Set<String> = [root.id]
        for c in root.children where c.isFolder { s.insert(c.id); for g in c.children where g.isFolder { s.insert(g.id) } }
        return s
    }

    private func flattened() -> [(ComposerStore.FileTreeNode, Int)] {
        var out: [(ComposerStore.FileTreeNode, Int)] = []
        func walk(_ n: ComposerStore.FileTreeNode, _ d: Int) {
            out.append((n, d))
            if expanded.contains(n.id) { for c in n.children { walk(c, d + 1) } }
        }
        walk(root, 0)
        return out
    }

    @ViewBuilder
    private func row(_ node: ComposerStore.FileTreeNode, depth: Int) -> some View {
        let isRoot = depth == 0
        let active = node.included

        HStack(spacing: 6) {
            // Folders aren't individually toggled — only files carry a checkbox.
            // (Excluding a subfolder is done by deselecting its files; the anchor
            // and intermediate folders stay structural.)
            NodeCheck(state: isRoot || node.isFolder ? .anchor : (active ? .on : .off), accent: accent,
                      disabled: isRoot || node.isFolder) {
                if !isRoot && !node.isFolder { onToggle(node.id) }
            }
            if node.childCount > 0 {
                Button {
                    if expanded.contains(node.id) { expanded.remove(node.id) } else { expanded.insert(node.id) }
                } label: {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8)).foregroundStyle(theme.inkMute)
                        .rotationEffect(.degrees(expanded.contains(node.id) ? 90 : 0))
                        .frame(width: 12, height: 12)
                }.buttonStyle(.plain)
            } else {
                Circle().fill(theme.inkMute.opacity(0.5)).frame(width: 3, height: 3).frame(width: 12)
            }
            Image(systemName: typeSymbol(node.isFolder ? .folder : .file, moc: false, kind: node.kind))
                .font(.system(size: 11)).foregroundStyle(node.isFolder ? accent : theme.inkSoft)
            Text(node.name)
                .font(.system(size: 12)).foregroundStyle(theme.ink).lineLimit(1)
                .strikethrough(!active, color: theme.inkMute)
            Spacer(minLength: 4)
            if node.na {
                Text(L("file.attachmentBadge"))
                    .font(.system(size: 8, design: .monospaced)).tracking(0.5).foregroundStyle(theme.inkMute)
                    .padding(.horizontal, 4).padding(.vertical, 0.5)
                    .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(theme.rule, lineWidth: 0.5))
            } else if !node.isFolder {
                Text("~\(fmtTok(node.weight))").font(.system(size: 9, design: .monospaced)).foregroundStyle(theme.inkMute)
            }
        }
        .padding(.vertical, 3).padding(.horizontal, 6)
        .padding(.leading, CGFloat(depth) * 15)
        .opacity(active ? 1 : 0.5)
    }
}

// MARK: Book card body — representation + scope + section list

private struct BookCardBody: View {
    @Environment(\.mauriceTheme) private var theme
    @Environment(ComposerStore.self) private var store
    let item: TrayItem
    let accent: Color
    @State private var chapters: [ComposerStore.BookChapter] = []
    @State private var showAll = false

    private var visible: [ComposerStore.BookChapter] { chapters.filter { !$0.hidden } }
    private var hiddenCount: Int { chapters.count - visible.count }

    // Refs currently in scope, client-side mirror of the server resolver.
    private var includedRefs: Set<String> {
        switch item.scopeMode {
        case "up_to":
            let last = min(max(0, item.uptoChapter), visible.count - 1)
            return Set(visible.prefix(last + 1).map(\.ref))
        case "chapters":
            return Set(item.selectedRefs)
        default:
            return Set(visible.map(\.ref))
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            row(L("book.representation")) {
                ComposerSegmented(
                    options: [("summary", L("book.representation.summary")), ("full", L("book.representation.full"))],
                    value: Binding(get: { item.representation }, set: { var c = item; c.representation = $0; store.update(c) }),
                    accent: accent)
            }
            row(L("book.scope")) {
                ComposerSegmented(
                    options: [("all", L("book.scope.all")), ("up_to", L("book.scope.upTo")), ("chapters", L("book.scope.select"))],
                    value: Binding(get: { item.scopeMode }, set: { setScope($0) }),
                    accent: accent)
            }

            if item.scopeMode == "up_to", !visible.isEmpty {
                let lastIdx = min(max(0, item.uptoChapter), visible.count - 1)
                HStack {
                    Text(L("book.upTo")).font(.system(size: 11.5)).foregroundStyle(theme.inkSoft)
                    Spacer()
                    Text(String(format: L("book.chapterNameLabel"), lastIdx + 1, visible[lastIdx].name))
                        .font(.system(size: 10.5, design: .monospaced)).foregroundStyle(accent.legible(onDark: theme.isDark)).lineLimit(1)
                }
                Slider(
                    value: Binding(
                        get: { Double(lastIdx) },
                        set: { var c = item; c.uptoChapter = Int($0.rounded()); store.update(c) }),
                    in: 0...Double(max(1, visible.count - 1)), step: 1)
                    .tint(accent.legible(onDark: theme.isDark))
                Text(L("book.spoilerSafe"))
                    .font(.system(size: 9.5, design: .monospaced)).foregroundStyle(theme.inkMute)
            }

            // Section list header + show-all disclosure
            HStack {
                Text(item.scopeMode == "chapters" ? L("book.chooseSections") : L("book.sectionsInScope"))
                    .font(.system(size: 9, design: .monospaced)).tracking(0.6).foregroundStyle(theme.inkMute)
                Spacer()
                if hiddenCount > 0 {
                    Button { showAll.toggle() } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "chevron.right").font(.system(size: 8))
                                .rotationEffect(.degrees(showAll ? 90 : 0))
                            Text(showAll ? L("book.hideBackMatter") : String(format: L("book.showAllSections"), hiddenCount))
                                .font(.system(size: 9.5, design: .monospaced))
                        }.foregroundStyle(theme.inkSoft)
                    }.buttonStyle(.plain)
                }
            }
            .padding(.top, 2)

            ScrollView {
                VStack(spacing: 0) {
                    ForEach(showAll ? chapters : visible) { ch in
                        ChapterRow(chapter: ch, mode: item.scopeMode,
                                   inScope: includedRefs.contains(ch.ref),
                                   selected: item.selectedRefs.contains(ch.ref),
                                   accent: accent) { toggleSelect(ch.ref) }
                    }
                }.padding(4)
            }
            .frame(maxHeight: 200)
            .background(RoundedRectangle(cornerRadius: 8).fill(theme.bg))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(theme.rule, lineWidth: 0.5))

            if !showAll, hiddenCount > 0 {
                Text(String(format: L("book.backMatterHidden"), hiddenCount))
                    .font(.system(size: 9, design: .monospaced)).foregroundStyle(theme.inkMute).opacity(0.85)
            }
        }
        .task(id: item.rawId) {
            if chapters.isEmpty { chapters = await store.bookChapters(item.rawId) }
        }
    }

    private func setScope(_ scope: String) {
        var c = item
        c.scopeMode = scope
        if scope == "up_to", c.uptoChapter == 0 { c.uptoChapter = min(6, max(0, visible.count - 1)) }
        if scope == "chapters", c.selectedRefs.isEmpty { c.selectedRefs = Array(includedRefs) }
        store.update(c)
    }

    private func toggleSelect(_ ref: String) {
        guard item.scopeMode == "chapters" else { return }
        var c = item
        if let i = c.selectedRefs.firstIndex(of: ref) { c.selectedRefs.remove(at: i) } else { c.selectedRefs.append(ref) }
        store.update(c)
    }

    @ViewBuilder private func row(_ label: String, @ViewBuilder _ control: () -> some View) -> some View {
        HStack {
            Text(label.uppercased()).font(.system(size: 9, design: .monospaced)).tracking(0.6).foregroundStyle(theme.inkMute)
            Spacer()
            control()
        }
    }
}

private struct ChapterRow: View {
    @Environment(\.mauriceTheme) private var theme
    let chapter: ComposerStore.BookChapter
    let mode: String
    let inScope: Bool
    let selected: Bool
    let accent: Color
    let onToggle: () -> Void

    private var matterLabel: String {
        let m = chapter.sectionType == "front_matter" ? L("book.matter.front")
              : chapter.sectionType == "back_matter" ? L("book.matter.back") : L("book.matter.section")
        return chapter.wordCount > 0 ? String(format: L("book.matter.words"), m, chapter.wordCount.formatted()) : m
    }

    var body: some View {
        HStack(spacing: 8) {
            if mode == "chapters" {
                RoundedRectangle(cornerRadius: 4)
                    .fill(selected ? accent : Color.clear)
                    .frame(width: 14, height: 14)
                    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(selected ? accent : theme.ruleHard, lineWidth: 1))
                    .overlay { if selected { Image(systemName: "checkmark").font(.system(size: 8, weight: .bold)).foregroundStyle(.white) } }
            } else {
                Circle().fill(inScope ? accent : theme.ruleHard).frame(width: 6, height: 6)
            }
            Text(chapter.name).font(.system(size: 12)).foregroundStyle(theme.ink).lineLimit(1)
            Spacer(minLength: 4)
            if chapter.hidden {
                Text(matterLabel)
                    .font(.system(size: 8.5, design: .monospaced)).foregroundStyle(CAUTION)
                    .padding(.horizontal, 4).padding(.vertical, 0.5)
                    .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(CAUTION.opacity(0.85), lineWidth: 0.5))
            }
        }
        .padding(.vertical, 5).padding(.horizontal, 8)
        .background(inScope && !chapter.hidden ? accent.opacity(0.12) : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .opacity(chapter.hidden ? 0.6 : 1)
        .contentShape(Rectangle())
        .onTapGesture { if mode == "chapters" { onToggle() } }
        .accessibilityAddTraits(mode == "chapters" ? .isButton : [])
        .accessibilityLabel(chapter.name)
    }
}

// MARK: Context tray (the dock section above the input)

private struct TrayCardsHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

struct ContextTray: View {
    @Environment(\.mauriceTheme) private var theme
    @Environment(ComposerStore.self) private var store
    let accent: Color
    /// Phone "review/trim" mode: when set, the header shows a Done button (not the
    /// Cards/Chips switch), an empty-state line, and a dashed "Add context" footer.
    var onDone: (() -> Void)? = nil
    var onAddMore: (() -> Void)? = nil
    @State private var openId: String?
    @State private var cardsHeight: CGFloat = 0

    private var trimMode: Bool { onDone != nil }

    var body: some View {
        @Bindable var store = store
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text(String(format: L("tray.contextCount"), store.items.count))
                    .font(.system(size: 9.5, design: .monospaced)).tracking(0.5)
                    .textCase(.uppercase).foregroundStyle(theme.inkMute)
                // Running total, inline — colored by tier (the "is this honest?" readout).
                Text(String(format: L("weight.ctxReadout"), fmtTok(store.displayTotal)))
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(tierColor(store.displayTotal, theme))
                // Binaries (img/pdf) carry no token estimate — surfaced separately.
                if store.attachmentCount > 0 {
                    HStack(spacing: 3) {
                        Image(systemName: "paperclip").font(.system(size: 9))
                        Text(String(format: L("file.attachmentsNoEstimate"), store.attachmentCount))
                            .font(.system(size: 9.5, design: .monospaced))
                    }
                    .foregroundStyle(theme.inkMute)
                }
                Spacer()
                if let onDone {
                    Button(L("common.done"), action: onDone)
                        .font(.system(size: 13.5, weight: .semibold))
                        .buttonStyle(.plain).foregroundStyle(accent.legible(onDark: theme.isDark))
                } else {
                    ComposerSegmented(
                        options: [("cards", L("tray.cards")), ("chips", L("tray.chips"))],
                        value: Binding(
                            get: { store.trayStyle == .cards ? "cards" : "chips" },
                            set: { store.trayStyle = $0 == "cards" ? .cards : .chips }),
                        accent: accent)
                }
            }
            .padding(.horizontal, 14).padding(.top, 9).padding(.bottom, 7)

            // The bound Maurice's baked-in context — loaded but not removable here.
            if store.lockedCount > 0 {
                HStack(spacing: 6) {
                    Image(systemName: "lock.fill").font(.system(size: 8))
                    Text(String(format: L("tray.bakedInto"), store.lockedCount, store.lockedName, fmtTok(store.lockedWeight)))
                        .font(.system(size: 9.5, design: .monospaced))
                }
                .foregroundStyle(theme.inkMute)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 14).padding(.bottom, 7)
            }

            if store.items.isEmpty && trimMode {
                Text(L("tray.noContextYet"))
                    .font(.system(size: 11, design: .monospaced)).foregroundStyle(theme.inkMute)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14).padding(.bottom, 10)
            } else if store.trayStyle == .cards || trimMode {
                // Scrollable so the dock never eats the whole screen, but the panel
                // sizes to its content (measured) up to the cap — no empty filler.
                ScrollView {
                    VStack(spacing: openId != nil ? 4 : 6) {
                        ForEach(store.items) { it in
                            TrayCard(item: it, accent: accent, openId: $openId)
                        }
                    }
                    .padding(.horizontal, 12).padding(.bottom, 8)
                    .background(GeometryReader { g in
                        Color.clear.preference(key: TrayCardsHeightKey.self, value: g.size.height)
                    })
                }
                .frame(height: min(max(cardsHeight, 1), 360))
                .onPreferenceChange(TrayCardsHeightKey.self) { cardsHeight = $0 }
            } else {
                FlowChips(items: store.items, accent: accent)
                    .padding(.horizontal, 12).padding(.bottom, 8)
            }

            if let onAddMore {
                Button(action: onAddMore) {
                    HStack(spacing: 7) {
                        Image(systemName: "plus").font(.system(size: 12))
                        Text(L("context.addContext")).font(.system(size: 12.5))
                    }
                    .foregroundStyle(theme.inkSoft)
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(theme.ruleHard, style: StrokeStyle(lineWidth: 0.5, dash: [3, 3])))
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 10).padding(.bottom, 10)
            }
        }
        #if os(iOS)
        .glassPanel(theme, cornerRadius: 18)
        #else
        .background(theme.surface)
        .overlay(alignment: .bottom) { Rectangle().fill(theme.rule).frame(height: 0.5) }
        #endif
    }
}

// Simple wrapping chip layout.
private struct FlowChips: View {
    @Environment(ComposerStore.self) private var store
    let items: [TrayItem]
    let accent: Color
    var body: some View {
        FlexWrap(items: items, spacing: 6) { it in
            CompactChip(item: it, accent: accent, weight: store.weightById[it.id] ?? 0,
                        count: store.countById[it.id], heavy: store.heavyById[it.id] ?? false,
                        onRemove: { store.remove(it.id) },
                        onOpen: { store.trayStyle = .cards })
        }
    }
}

// Minimal flow layout (iOS 16+ Layout).
struct FlexWrap<Item: Identifiable, Content: View>: View {
    let items: [Item]
    let spacing: CGFloat
    @ViewBuilder let content: (Item) -> Content
    var body: some View {
        FlowLayout(spacing: spacing) {
            ForEach(items) { content($0) }
        }
    }
}

struct FlowLayout: Layout {
    var spacing: CGFloat = 6
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxW = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x + sz.width > maxW { x = 0; y += rowH + spacing; rowH = 0 }
            x += sz.width + spacing; rowH = max(rowH, sz.height)
        }
        return CGSize(width: maxW == .infinity ? x : maxW, height: y + rowH)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x + sz.width > bounds.maxX { x = bounds.minX; y += rowH + spacing; rowH = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(sz))
            x += sz.width + spacing; rowH = max(rowH, sz.height)
        }
    }
}

// MARK: Add-context bottom sheet (search picker)

struct AddContextSheet: View {
    @Environment(\.mauriceTheme) private var theme
    @Environment(ComposerStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let accent: Color
    @State private var q = ""
    @State private var results: [SearchEntry] = []
    @State private var showImporter = false
    @State private var uploading = false

    private var groups: [(label: String, type: ComposerItemType)] {
        [(L("context.section.notes"), .note), (L("context.section.books"), .book),
         (L("context.section.folders"), .folder), (L("context.section.files"), .file),
         (L("context.section.conversations"), .conversation)]
    }

    var body: some View {
        VStack(spacing: 0) {
            // Serif title + Done, left-aligned (the mobile-native picker header).
            HStack(alignment: .firstTextBaseline) {
                Text(L("context.addContext")).font(.system(size: 21, design: .serif)).foregroundStyle(theme.ink)
                Spacer()
                Button(L("common.done")) { dismiss() }
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(accent.legible(onDark: theme.isDark))
            }
            .padding(.horizontal, 18).padding(.top, 10).padding(.bottom, 10)

            TextField(L("context.searchPlaceholder"), text: $q)
                .textFieldStyle(.plain).font(.system(size: 15))
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 10).fill(theme.bg))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(theme.rule, lineWidth: 0.5))
                .padding(.horizontal, 16).padding(.bottom, 8)

            // Upload a document straight into the library and attach it (file-at-birth).
            Button { showImporter = true } label: {
                HStack(spacing: 7) {
                    Image(systemName: uploading ? "arrow.up.circle" : "arrow.up.doc").font(.system(size: 13))
                    Text(uploading ? L("context.uploading") : L("context.uploadFile")).font(.system(size: 12.5))
                }
                .foregroundStyle(theme.inkSoft)
                .padding(.horizontal, 10).padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(theme.ruleHard, style: StrokeStyle(lineWidth: 0.5, dash: [3, 3])))
            }
            .buttonStyle(.plain).disabled(uploading)
            .padding(.horizontal, 16).padding(.bottom, 8)

            List {
                ForEach(groups, id: \.label) { g in
                    let rows = results.filter { $0.type == g.type }
                    if !rows.isEmpty {
                        Section {
                            ForEach(rows) { e in row(e) }
                        } header: {
                            Text(g.label).font(.system(size: 9.5, design: .monospaced)).tracking(0.7)
                                .textCase(.uppercase).foregroundStyle(theme.inkMute)
                        }
                    }
                }
                if results.isEmpty && !q.isEmpty {
                    Text(String(format: L("context.nothingMatches"), q)).font(.system(size: 12, design: .monospaced)).foregroundStyle(theme.inkMute)
                }
            }
            .listStyle(.plain)
        }
        .background(theme.surface)
        #if os(macOS)
        // macOS sizes a sheet to its content; without an explicit frame the
        // results List collapses to zero height (reads as "search is broken").
        .frame(minWidth: 480, idealWidth: 520, minHeight: 560, idealHeight: 640)
        #endif
        .task(id: q) {
            results = await store.search(q)
        }
        .fileImporter(isPresented: $showImporter, allowedContentTypes: [.item]) { result in
            guard case .success(let url) = result else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let name = url.lastPathComponent
            guard let data = try? Data(contentsOf: url) else { return }
            uploading = true
            Task { await store.addUploadedFile(name: name, data: data); uploading = false }
        }
    }

    private func row(_ e: SearchEntry) -> some View {
        let on = store.has(e.id)
        return Button { store.toggle(e) } label: {
            HStack(spacing: 12) {
                Image(systemName: typeSymbol(e.type, moc: e.moc, kind: e.kind)).font(.system(size: 16))
                    .foregroundStyle(on ? accent : theme.inkSoft).frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(e.title).font(.system(size: 15, weight: on ? .semibold : .regular)).foregroundStyle(theme.ink).lineLimit(1)
                        if e.encrypted { Image(systemName: "lock.fill").font(.system(size: 9)).foregroundStyle(theme.inkMute) }
                    }
                    Text(e.sub).font(.system(size: 10, design: .monospaced)).foregroundStyle(theme.inkMute).lineLimit(1)
                }
                Spacer()
                Image(systemName: on ? "checkmark.circle.fill" : "plus.circle")
                    .font(.system(size: 18)).foregroundStyle(on ? accent : theme.inkMute)
            }
        }
        .buttonStyle(.plain)
        .listRowBackground(on ? accent.opacity(0.10) : Color.clear)
    }
}
