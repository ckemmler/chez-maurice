import SwiftUI
import SwiftMath
import CoreText
#if os(iOS)
import UIKit
import UniformTypeIdentifiers
#else
import AppKit
#endif

// ── A message body as one selectable text ────────────────────────
//
// The body is laid out as ONE attributed string in ONE text view (TextKit 1,
// UITextView / NSTextView), so a selection runs from the first word to the
// last, across paragraphs, lists, quotes, code and tables — as it does in a
// page of a book, and as it could not in a stack of one SwiftUI view per
// block. What a text view cannot draw by itself — the panel behind a code
// block, the bar beside a quote, a table's rules, a horizontal rule — the
// layout manager draws behind the glyphs (`ReplyLayoutManager`).
//
// Only what is not text breaks the flow: a long paste or a shared article in
// the member's message stays a card between two texts.
//
// Markdown is read by Foundation (`AttributedString(markdown:)`, full syntax),
// which reports each run's block structure; TeX is turned into image
// attachments drawn by SwiftMath, and copies back as TeX.

#if os(iOS)
typealias ReplyFont = UIFont
typealias ReplyColor = UIColor
#else
typealias ReplyFont = NSFont
typealias ReplyColor = NSColor
#endif

// MARK: - Style

/// The theme's tokens, in the units a text view takes.
struct ReplyStyle: Hashable {
    let ink: Color
    let inkSoft: Color
    let inkMute: Color
    let rule: Color
    let codeBg: Color
    let codeInk: Color
    var bodySize: CGFloat = kBodyFont
    var lineSpacing: CGFloat = kBodyLineSpacing

    init(_ t: MauriceTheme) {
        ink = t.ink; inkSoft = t.inkSoft; inkMute = t.inkMute
        rule = t.rule; codeBg = t.codeBg; codeInk = t.codeInk
    }

    var codeSize: CGFloat { (bodySize * 0.87).rounded() }
    /// Between two blocks.
    var gap: CGFloat { (bodySize * 0.75).rounded() }
    /// Between two items of one list.
    var itemGap: CGFloat { (bodySize * 0.3).rounded() }
    /// One level of list.
    var listStep: CGFloat { (bodySize * 1.45).rounded() }
    /// One level of quote: the bar, then the space after it.
    var quoteStep: CGFloat { 15 }
    var codePadH: CGFloat { 10 }
    var codePadBottom: CGFloat { 10 }
    /// The code block's top band: its language and its copy button.
    var codeHeader: CGFloat { 26 }
    var cellPadH: CGFloat { 8 }
    var cellPadV: CGFloat { 5 }

    func color(_ c: Color) -> ReplyColor { ReplyColor(c) }

    func font(size: CGFloat? = nil, weight: ReplyFont.Weight = .regular, italic: Bool = false, mono: Bool = false) -> ReplyFont {
        let s = size ?? bodySize
        let base: ReplyFont = mono ? .monospacedSystemFont(ofSize: s, weight: weight) : .systemFont(ofSize: s, weight: weight)
        guard italic else { return base }
        #if os(iOS)
        let d = base.fontDescriptor
        guard let it = d.withSymbolicTraits(d.symbolicTraits.union(.traitItalic)) else { return base }
        return UIFont(descriptor: it, size: s)
        #else
        let d = base.fontDescriptor.withSymbolicTraits(base.fontDescriptor.symbolicTraits.union(.italic))
        return NSFont(descriptor: d, size: s) ?? base
        #endif
    }
}

// MARK: - Attributes

extension NSAttributedString.Key {
    /// What a range copies as, when it is not its own characters: a list
    /// marker ("• "), a formula (its TeX), a rule ("---").
    static let replyCopyText = NSAttributedString.Key("maurice.reply.copyText")
    /// A code block (CodeMark), over its code.
    static let replyCode = NSAttributedString.Key("maurice.reply.code")
    /// A quote (QuoteMark), over its paragraphs.
    static let replyQuote = NSAttributedString.Key("maurice.reply.quote")
    /// A horizontal rule (a bare marker object).
    static let replyRule = NSAttributedString.Key("maurice.reply.rule")
    /// A table row laid out as a grid (TableRowMark).
    static let replyTableRow = NSAttributedString.Key("maurice.reply.tableRow")
    /// The first line of a table row read as a record, on a narrow page.
    static let replyRecord = NSAttributedString.Key("maurice.reply.record")
    /// A display formula, scaled down when the page is narrower.
    static let replyMath = NSAttributedString.Key("maurice.reply.math")
    /// Inline code, set on a soft box.
    static let replyInlineCode = NSAttributedString.Key("maurice.reply.inlineCode")
}

/// A code block: what its copy button copies, and its language.
final class CodeMark: NSObject {
    let language: String
    let code: String
    init(language: String, code: String) { self.language = language; self.code = code }
}

/// A quote: where its bars stand, one per level.
final class QuoteMark: NSObject {
    let bars: [CGFloat]
    init(bars: [CGFloat]) { self.bars = bars }
}

/// One row of a grid table, and the grid it belongs to.
final class TableRowMark: NSObject {
    let left: CGFloat
    /// The x of each column's left edge, then the table's right edge.
    let edges: [CGFloat]
    let header: Bool
    let last: Bool
    /// Space above the row that belongs to what precedes it, not to the row.
    let skip: CGFloat
    init(left: CGFloat, edges: [CGFloat], header: Bool, last: Bool, skip: CGFloat) {
        self.left = left; self.edges = edges; self.header = header; self.last = last; self.skip = skip
    }
}

/// A display formula's natural size, kept so it can shrink to fit and grow back.
final class MathMark: NSObject {
    let size: CGSize
    let attachment: NSTextAttachment
    init(size: CGSize, attachment: NSTextAttachment) { self.size = size; self.attachment = attachment }
}

// MARK: - Document

/// A message body, parsed: texts, and the cards between them.
final class ReplyDocument {
    enum Piece {
        case text(ReplyBody)
        case paste(String)
        case article(SharedArticle)
    }
    let pieces: [Piece]
    init(pieces: [Piece]) { self.pieces = pieces }

    private static let cache: NSCache<NSString, ReplyDocument> = {
        let c = NSCache<NSString, ReplyDocument>()
        c.countLimit = 300
        return c
    }()

    /// The parsed body, from the cache when this text in this style was read before.
    static func make(_ markdown: String, style: ReplyStyle) -> ReplyDocument {
        let key = "\(style.hashValue)|\(markdown)" as NSString
        if let hit = cache.object(forKey: key) { return hit }
        let doc = ReplyBuilder(style: style).build(markdown)
        cache.setObject(doc, forKey: key)
        return doc
    }
}

/// One stretch of text: fixed paragraphs, and tables whose layout waits for
/// the width of the page.
final class ReplyBody {
    enum Chunk {
        case text(NSAttributedString)
        case table(ReplyTable)
    }
    let chunks: [Chunk]
    let style: ReplyStyle
    /// Space the drawing takes below the last line (a code block's panel).
    let bottomOverhang: CGFloat
    private var fixed: NSAttributedString?
    private var lastWidth: CGFloat = -1
    private var lastString: NSAttributedString?

    init(chunks: [Chunk], style: ReplyStyle, bottomOverhang: CGFloat) {
        self.chunks = chunks; self.style = style; self.bottomOverhang = bottomOverhang
    }

    /// Whether the text depends on the width of the page.
    var dependsOnWidth: Bool {
        chunks.contains { if case .table = $0 { return true } else { return false } }
            || hasDisplayMath
    }

    private lazy var hasDisplayMath: Bool = {
        chunks.contains { chunk in
            guard case .text(let s) = chunk else { return false }
            var found = false
            s.enumerateAttribute(.replyMath, in: NSRange(location: 0, length: s.length)) { v, _, stop in
                if v != nil { found = true; stop.pointee = true }
            }
            return found
        }
    }()

    /// The text for a page this wide.
    func attributed(width: CGFloat) -> NSAttributedString {
        if !dependsOnWidth {
            if let fixed { return fixed }
            let s = assemble(width: .greatestFiniteMagnitude)
            fixed = s
            return s
        }
        if let lastString, abs(lastWidth - width) < 0.5 { return lastString }
        let s = assemble(width: width)
        lastWidth = width
        lastString = s
        return s
    }

    private func assemble(width: CGFloat) -> NSAttributedString {
        let out = NSMutableAttributedString()
        for chunk in chunks {
            switch chunk {
            case .text(let s): out.append(s)
            case .table(let t): out.append(t.render(width: width, style: style))
            }
        }
        // Every paragraph was closed with its newline; the last needs none.
        if out.string.hasSuffix("\n") {
            out.deleteCharacters(in: NSRange(location: out.length - 1, length: 1))
        }
        // A display formula wider than the page shrinks to it.
        out.enumerateAttribute(.replyMath, in: NSRange(location: 0, length: out.length)) { v, _, _ in
            guard let m = v as? MathMark else { return }
            let scale = width.isFinite ? min(1, width / max(m.size.width, 1)) : 1
            m.attachment.bounds = CGRect(x: 0, y: 0, width: m.size.width * scale, height: m.size.height * scale)
        }
        return out
    }
}

// MARK: - Tables

/// A table, held as cells until the page's width says whether it can stand
/// as a grid or must be read row by row.
final class ReplyTable {
    var alignments: [NSTextAlignment] = []
    var header: [NSAttributedString] = []
    var rows: [[NSAttributedString]] = []
    var indent: CGFloat = 0
    var spacingBefore: CGFloat = 0

    func render(width: CGFloat, style: ReplyStyle) -> NSAttributedString {
        let columns = max(header.count, rows.map(\.count).max() ?? 0)
        guard columns > 0 else { return NSAttributedString() }
        var widths = Array(repeating: CGFloat(0), count: columns)
        for row in [header] + rows {
            for (i, cell) in row.enumerated() {
                let w = cell.boundingRect(with: CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude),
                                          options: [.usesLineFragmentOrigin], context: nil).width
                widths[i] = max(widths[i], ceil(w) + 2 * style.cellPadH)
            }
        }
        let total = widths.reduce(0, +)
        if indent + total <= width {
            return grid(widths: widths, style: style)
        }
        return records(style: style)
    }

    /// Rows and columns, each row one line, the columns held by tab stops.
    private func grid(widths: [CGFloat], style: ReplyStyle) -> NSAttributedString {
        var edges: [CGFloat] = [indent]
        for w in widths { edges.append(edges.last! + w) }
        var tabs: [NSTextTab] = []
        for i in 0..<widths.count {
            let a = i < alignments.count ? alignments[i] : .natural
            switch a {
            case .center: tabs.append(NSTextTab(textAlignment: .center, location: (edges[i] + edges[i + 1]) / 2))
            case .right: tabs.append(NSTextTab(textAlignment: .right, location: edges[i + 1] - style.cellPadH))
            default: tabs.append(NSTextTab(textAlignment: .left, location: edges[i] + style.cellPadH))
            }
        }
        let all: [(cells: [NSAttributedString], header: Bool)] =
            (header.isEmpty ? [] : [(header, true)]) + rows.map { ($0, false) }
        let out = NSMutableAttributedString()
        for (n, row) in all.enumerated() {
            let ps = NSMutableParagraphStyle()
            ps.tabStops = tabs
            ps.firstLineHeadIndent = indent
            ps.headIndent = indent
            ps.lineBreakMode = .byClipping
            let skip = n == 0 ? spacingBefore : 0
            ps.paragraphSpacingBefore = skip + style.cellPadV
            ps.paragraphSpacing = style.cellPadV
            let line = NSMutableAttributedString()
            for i in 0..<widths.count {
                // Each cell opens on a tab, which copies as nothing before the
                // first cell and as a tab between two.
                line.append(NSAttributedString(string: "\t", attributes: i == 0 ? [.replyCopyText: ""] : [:]))
                if i < row.cells.count { line.append(row.cells[i]) }
            }
            let base: [NSAttributedString.Key: Any] = [.font: style.font(), .foregroundColor: style.color(style.ink)]
            line.append(NSAttributedString(string: "\n"))
            let range = NSRange(location: 0, length: line.length)
            line.enumerateAttribute(.font, in: range) { v, r, _ in
                if v == nil { line.addAttributes(base, range: r) }
            }
            line.addAttribute(.paragraphStyle, value: ps, range: range)
            line.addAttribute(.replyTableRow,
                              value: TableRowMark(left: indent, edges: edges, header: row.header,
                                                  last: n == all.count - 1, skip: skip),
                              range: NSRange(location: 0, length: line.length - 1))
            out.append(line)
        }
        return out
    }

    /// "Column : value" in French, "Column: value" elsewhere.
    private static var colon: String {
        (Locale.preferredLanguages.first ?? "").hasPrefix("fr") ? "\u{202F}: " : ": "
    }

    /// Too wide for the page: each row becomes a short record — its first
    /// cell as a title, then "Column: value" lines.
    private func records(style: ReplyStyle) -> NSAttributedString {
        let out = NSMutableAttributedString()
        let names = header.map { $0.string.trimmingCharacters(in: .whitespaces) }
        let body = rows.isEmpty ? [header] : rows
        for (n, row) in body.enumerated() {
            for (i, cell) in row.enumerated() {
                let ps = NSMutableParagraphStyle()
                ps.firstLineHeadIndent = indent
                ps.headIndent = indent
                ps.lineSpacing = style.lineSpacing
                let line = NSMutableAttributedString()
                if i == 0 {
                    ps.paragraphSpacingBefore = n == 0 ? spacingBefore : style.gap
                    line.append(cell)
                    line.addAttribute(.font, value: style.font(weight: .semibold), range: NSRange(location: 0, length: line.length))
                } else {
                    ps.paragraphSpacingBefore = 2
                    if i < names.count, !names[i].isEmpty, !rows.isEmpty {
                        line.append(NSAttributedString(string: names[i] + Self.colon, attributes: [
                            .font: style.font(size: style.bodySize * 0.9), .foregroundColor: style.color(style.inkMute)]))
                    }
                    line.append(cell)
                }
                line.append(NSAttributedString(string: "\n"))
                let range = NSRange(location: 0, length: line.length)
                line.enumerateAttribute(.font, in: range) { v, r, _ in
                    if v == nil { line.addAttribute(.font, value: style.font(), range: r) }
                }
                line.enumerateAttribute(.foregroundColor, in: range) { v, r, _ in
                    if v == nil { line.addAttribute(.foregroundColor, value: style.color(style.ink), range: r) }
                }
                line.addAttribute(.paragraphStyle, value: ps, range: range)
                if i == 0, n > 0 {
                    line.addAttribute(.replyRecord, value: NSNumber(value: Double(indent)), range: NSRange(location: 0, length: line.length - 1))
                }
                out.append(line)
            }
        }
        return out
    }
}

// MARK: - Builder

/// Reads markdown into pieces of attributed text.
private final class ReplyBuilder {
    let style: ReplyStyle

    init(style: ReplyStyle) { self.style = style }

    private enum Kind: Equatable {
        case paragraph, heading(Int), code, rule, math, table
        var isHeading: Bool { if case .heading = self { return true } else { return false } }
    }

    /// Where a paragraph sits: inside which list items and quotes.
    private struct Context {
        var quotes: [Int] = []
        /// Outer to inner: (list id, ordered, item id, ordinal).
        var items: [(list: Int, ordered: Bool, item: Int, ordinal: Int)] = []
    }

    private struct Unit {
        let id: Int
        let kind: Kind
        let context: Context
        let start: Int
        let style: NSParagraphStyle
        var code: (language: String, text: String)?
    }

    private var pieces: [ReplyDocument.Piece] = []
    private var chunks: [ReplyBody.Chunk] = []
    private var text = NSMutableAttributedString()
    private var unit: Unit?
    private var lastKind: Kind?
    private var lastContext = Context()
    private var marked = Set<Int>()
    private var quoteMarks: [Int: QuoteMark] = [:]
    private var table: (id: Int, model: ReplyTable, row: Int?, cells: [NSMutableAttributedString], header: Bool)?
    private var island: (id: Int, language: String, text: String)?

    // MARK: Entry

    func build(_ markdown: String) -> ReplyDocument {
        let source = Self.mathMarkup(markdown)
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: true, interpretedSyntax: .full,
            failurePolicy: .returnPartiallyParsedIfPossible)
        guard let parsed = try? AttributedString(markdown: source, options: options) else {
            text.append(NSAttributedString(string: markdown, attributes: [
                .font: style.font(), .foregroundColor: style.color(style.ink)]))
            flushText()
            return ReplyDocument(pieces: pieces)
        }
        for run in parsed.runs {
            consume(run, String(parsed[run.range].characters))
        }
        closeUnit()
        closeTable()
        closeIsland()
        flushText()
        return ReplyDocument(pieces: pieces)
    }

    // MARK: Runs

    private func consume(_ run: AttributedString.Runs.Run, _ string: String) {
        let components = run.presentationIntent?.components ?? []
        let leaf = components.first

        // A long paste or an article: a card, not text.
        if let leaf, case .codeBlock(let lang) = leaf.kind,
           let lang, lang == PastedText.fenceInfo || lang == SharedArticle.fenceInfo {
            closeUnit()
            closeTable()
            if island?.id != leaf.identity {
                closeIsland()
                island = (leaf.identity, lang, "")
            }
            island?.text += string
            return
        }
        closeIsland()

        // A table cell: the table collects it.
        if let leaf, case .tableCell(let column) = leaf.kind, components.count >= 3 {
            closeUnit()
            let rowIntent = components[1]
            let tableIntent = components[2]
            if table?.id != tableIntent.identity {
                closeTable()
                let model = ReplyTable()
                if case .table(let columns) = tableIntent.kind {
                    model.alignments = columns.map {
                        switch $0.alignment {
                        case .center: return .center
                        case .right: return .right
                        default: return .natural
                        }
                    }
                }
                let ctx = context(of: Array(components.dropFirst(3)))
                model.indent = indent(of: ctx)
                model.spacingBefore = spacing(before: .table, context: ctx)
                table = (tableIntent.identity, model, nil, [], false)
            }
            if table?.row != rowIntent.identity {
                commitRow()
                table?.row = rowIntent.identity
                if case .tableHeaderRow = rowIntent.kind { table?.header = true } else { table?.header = false }
            }
            while (table?.cells.count ?? 0) <= column { table?.cells.append(NSMutableAttributedString()) }
            if let url = run.imageURL ?? run.link, let math = mathImage(url) {
                table?.cells[column].append(math)
            } else if run.imageURL == nil {
                table?.cells[column].append(inline(run, string, size: style.bodySize,
                                                   weight: table?.header == true ? .semibold : .regular))
            }
            return
        }
        closeTable()

        let id = leaf?.identity ?? -1
        if unit?.id != id {
            closeUnit()
            openUnit(id: id, components: components)
        }
        guard let unit else { return }
        switch unit.kind {
        case .code:
            self.unit?.code?.text += string
        case .rule:
            break
        case .heading(let level):
            text.append(inline(run, string, size: headingSize(level), weight: .semibold))
        default:
            if let url = run.imageURL ?? run.link, let math = mathImage(url) {
                text.append(math)
            } else if run.imageURL != nil {
                break // an image's alt text: images are drawn elsewhere
            } else {
                text.append(inline(run, string, size: style.bodySize, weight: .regular))
            }
        }
    }

    private func headingSize(_ level: Int) -> CGFloat {
        switch level {
        case 1: return (style.bodySize * 1.32).rounded()
        case 2: return (style.bodySize * 1.18).rounded()
        case 3: return (style.bodySize * 1.06).rounded()
        default: return style.bodySize
        }
    }

    /// A run's characters with its inline marks.
    private func inline(_ run: AttributedString.Runs.Run, _ string: String, size: CGFloat, weight: ReplyFont.Weight) -> NSAttributedString {
        let intent = run.inlinePresentationIntent ?? []
        var s = string
        if intent.contains(.lineBreak) { s = "\u{2028}" }
        var attrs: [NSAttributedString.Key: Any] = [.foregroundColor: style.color(style.ink)]
        if intent.contains(.code) {
            attrs[.font] = style.font(size: style.codeSize * size / style.bodySize, mono: true)
            attrs[.foregroundColor] = style.color(style.codeInk)
            attrs[.replyInlineCode] = true
        } else {
            let strong = intent.contains(.stronglyEmphasized)
            attrs[.font] = style.font(size: size, weight: strong ? .semibold : weight, italic: intent.contains(.emphasized))
        }
        if intent.contains(.strikethrough) {
            attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
        }
        if let link = run.link {
            attrs[.link] = link
        }
        return NSAttributedString(string: s, attributes: attrs)
    }

    // MARK: Paragraphs

    private func context(of components: [PresentationIntent.IntentType]) -> Context {
        var ctx = Context()
        // Outer to inner.
        let outward = Array(components.reversed())
        for (i, c) in outward.enumerated() {
            switch c.kind {
            case .blockQuote:
                ctx.quotes.append(c.identity)
            case .listItem(let ordinal):
                // The list is the component just outside the item.
                var ordered = false
                var list = -1
                if i > 0 {
                    list = outward[i - 1].identity
                    if case .orderedList = outward[i - 1].kind { ordered = true }
                }
                ctx.items.append((list, ordered, c.identity, ordinal))
            default:
                break
            }
        }
        return ctx
    }

    private func indent(of ctx: Context) -> CGFloat {
        CGFloat(ctx.items.count) * style.listStep + CGFloat(ctx.quotes.count) * style.quoteStep
    }

    private func spacing(before kind: Kind, context ctx: Context) -> CGFloat {
        guard let last = lastKind else { return 0 }
        // After a code block, its panel's bottom pad sits in the gap.
        let pad = last == .code ? style.codePadBottom : 0
        return pad + gap(before: kind, after: last, context: ctx)
    }

    private func gap(before kind: Kind, after last: Kind, context ctx: Context) -> CGFloat {
        if case .heading = kind { return (style.bodySize * 1.1).rounded() }
        if case .heading = last { return (style.bodySize * 0.4).rounded() }
        // Two items of one list sit close.
        if let a = ctx.items.first, let b = lastContext.items.first, a.list == b.list,
           kind == .paragraph, last == .paragraph {
            return style.itemGap
        }
        return style.gap
    }

    private func openUnit(id: Int, components: [PresentationIntent.IntentType]) {
        let leaf = components.first
        var kind = Kind.paragraph
        var language = ""
        switch leaf?.kind {
        case .header(let level)?: kind = .heading(level)
        case .codeBlock(let lang)?: kind = .code; language = lang ?? ""
        case .thematicBreak?: kind = .rule
        default: break
        }
        let ctx = context(of: Array(components.dropFirst()))
        let base = indent(of: ctx)
        let start = text.length
        var before = spacing(before: kind, context: ctx)
        let ps = NSMutableParagraphStyle()
        ps.lineSpacing = style.lineSpacing
        ps.firstLineHeadIndent = base
        ps.headIndent = base

        // The first paragraph of a list item carries its marker, hung in the margin.
        if let item = ctx.items.last, !marked.contains(item.item), kind == .paragraph || kind.isHeading {
            marked.insert(item.item)
            let depth = ctx.items.count
            let marker = item.ordered ? "\(item.ordinal)." : ["•", "◦", "▪"][(depth - 1) % 3]
            ps.firstLineHeadIndent = base - style.listStep
            ps.tabStops = [NSTextTab(textAlignment: .right, location: base - 7),
                           NSTextTab(textAlignment: .left, location: base)]
            let markerFont = item.ordered ? style.font().withMonospacedDigits : style.font()
            text.append(NSAttributedString(string: "\t\(marker)\t", attributes: [
                .font: markerFont, .foregroundColor: style.color(item.ordered ? style.inkSoft : style.ink),
                .replyCopyText: "\(String(repeating: "  ", count: depth - 1))\(item.ordered ? marker : "•") "]))
        }

        if kind == .code {
            ps.lineSpacing = 1.5
            ps.firstLineHeadIndent = base + style.codePadH
            ps.headIndent = base + style.codePadH
            ps.tailIndent = -style.codePadH
            ps.lineBreakMode = .byCharWrapping
            before += style.codeHeader
        }
        if case .rule = kind {
            text.append(NSAttributedString(string: " ", attributes: [
                .font: style.font(size: style.bodySize * 0.6), .replyRule: NSNumber(value: Double(base)),
                .replyCopyText: "---"]))
        }
        ps.paragraphSpacingBefore = before
        unit = Unit(id: id, kind: kind, context: ctx, start: start, style: ps,
                    code: kind == .code ? (language, "") : nil)
    }

    private func closeUnit() {
        guard let u = unit else { return }
        unit = nil
        // The style the closing newline carries: its paragraph's own.
        var closing: NSParagraphStyle = u.style
        if u.kind == .code, let code = u.code {
            var body = code.text
            while body.hasSuffix("\n") { body.removeLast() }
            let start = text.length
            text.append(NSAttributedString(string: body.isEmpty ? " " : body, attributes: [
                .font: style.font(size: style.codeSize, mono: true),
                .foregroundColor: style.color(style.codeInk)]))
            let range = NSRange(location: start, length: text.length - start)
            text.addAttribute(.replyCode, value: CodeMark(language: code.language, code: body), range: range)
            // Only the first line takes the space above the block.
            let rest = u.style.mutableCopy() as! NSMutableParagraphStyle
            rest.paragraphSpacingBefore = 0
            text.addAttribute(.paragraphStyle, value: rest, range: range)
            let firstLineEnd = (text.string as NSString).range(of: "\n", range: range).location
            let first = NSRange(location: start, length: (firstLineEnd == NSNotFound ? text.length : firstLineEnd) - start)
            text.addAttribute(.paragraphStyle, value: u.style, range: first)
            if firstLineEnd != NSNotFound { closing = rest }
        }
        let range = NSRange(location: u.start, length: text.length - u.start)
        if u.kind != .code {
            text.addAttribute(.paragraphStyle, value: u.style, range: range)
        }
        if let q = u.context.quotes.last {
            let mark = quoteMarks[q] ?? {
                let base = CGFloat(u.context.items.count) * style.listStep
                let bars = (0..<u.context.quotes.count).map { base + CGFloat($0) * style.quoteStep }
                let m = QuoteMark(bars: bars)
                quoteMarks[q] = m
                return m
            }()
            if u.kind != .code {
                text.addAttribute(.foregroundColor, value: style.color(style.inkSoft), range: range)
            }
            text.addAttribute(.replyQuote, value: mark, range: range)
        }
        text.append(NSAttributedString(string: "\n", attributes: [.paragraphStyle: closing, .font: style.font()]))
        if let q = u.context.quotes.last, let mark = quoteMarks[q] {
            // The newline joins the quote, so its bar runs on to the next paragraph.
            text.addAttribute(.replyQuote, value: mark, range: NSRange(location: text.length - 1, length: 1))
        }
        lastKind = u.kind
        lastContext = u.context
    }

    // MARK: Tables

    private func commitRow() {
        guard let t = table, t.row != nil else { return }
        if t.header { t.model.header = t.cells } else { t.model.rows.append(t.cells) }
        table?.cells = []
    }

    private func closeTable() {
        guard table != nil else { return }
        commitRow()
        flushChunk()
        chunks.append(.table(table!.model))
        table = nil
        lastKind = .table
        lastContext = Context()
    }

    // MARK: Cards

    private func closeIsland() {
        guard let i = island else { return }
        island = nil
        flushText()
        let body = i.text.hasSuffix("\n") ? String(i.text.dropLast()) : i.text
        pieces.append(i.language == PastedText.fenceInfo ? .paste(body) : .article(SharedArticle(block: body)))
    }

    private func flushChunk() {
        guard text.length > 0 else { return }
        chunks.append(.text(text))
        text = NSMutableAttributedString()
    }

    /// Close the running text into a piece; what follows starts afresh.
    private func flushText() {
        flushChunk()
        guard !chunks.isEmpty else { return }
        let overhang = lastKind == .code ? style.codePadBottom : 0
        pieces.append(.text(ReplyBody(chunks: chunks, style: style, bottomOverhang: overhang)))
        chunks = []
        lastKind = nil
        lastContext = Context()
    }

    // MARK: Math

    private static let mathScheme = "maurice-math:"
    private static let displayScheme = "maurice-math-display:"

    /// TeX spans become image references Foundation will carry through as
    /// runs: `\(…\)` inline, `\[…\]` and `$$…$$` on their own paragraph.
    /// Code — fenced or inline — is left alone.
    static func mathMarkup(_ text: String) -> String {
        guard text.contains("\\(") || text.contains("\\[") || text.contains("$$") else { return text }
        let pattern = #"((`{3,})[\s\S]*?\2)|(`[^`]*`)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|\\\(([\s\S]*?)\\\)"#
        guard let re = try? NSRegularExpression(pattern: pattern) else { return text }
        let ns = text as NSString
        var out = ""
        var last = 0
        for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            last = m.range.location + m.range.length
            func grp(_ i: Int) -> String? {
                let r = m.range(at: i)
                return r.location == NSNotFound ? nil : ns.substring(with: r)
            }
            if grp(1) != nil || grp(3) != nil {
                out += ns.substring(with: m.range)
            } else if let b = grp(4) ?? grp(5) {
                out += "\n\n![math](\(displayScheme)\(encode(b)))\n\n"
            } else if let i = grp(6) {
                out += "![math](\(mathScheme)\(encode(i)))"
            }
        }
        out += ns.substring(from: last)
        return out
    }

    private static func encode(_ latex: String) -> String {
        let trimmed = latex.trimmingCharacters(in: .whitespacesAndNewlines)
        return Data(trimmed.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func decode(_ s: String) -> String? {
        var b64 = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let data = Data(base64Encoded: b64) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// A formula, drawn, as an attachment that copies as its TeX.
    private func mathImage(_ url: URL) -> NSAttributedString? {
        let s = url.absoluteString
        let display = s.hasPrefix(Self.displayScheme)
        guard display || s.hasPrefix(Self.mathScheme),
              let latex = Self.decode(String(s.dropFirst(display ? Self.displayScheme.count : Self.mathScheme.count)))
        else { return nil }
        let color = style.color(style.ink)
        var mi = MathImage(latex: latex, fontSize: style.bodySize, textColor: color,
                           labelMode: display ? .display : .text, textAlignment: .left)
        let (err, img, info) = mi.asImage()
        let copy = display ? "$$\(latex)$$" : "\\(\(latex)\\)"
        guard err == nil, let img, let info else {
            return NSAttributedString(string: latex, attributes: [
                .font: style.font(size: style.codeSize, mono: true),
                .foregroundColor: style.color(style.codeInk)])
        }
        let attachment = NSTextAttachment()
        attachment.image = img
        let size = img.size
        // SwiftMath centres the formula in its image; its baseline sits the
        // descent above the formula's bottom.
        let h = max(info.ascent + info.descent, style.bodySize / 2)
        let baseline = (size.height - h) / 2 + info.descent
        attachment.bounds = CGRect(x: 0, y: display ? 0 : -baseline, width: size.width, height: size.height)
        let out = NSMutableAttributedString(attachment: attachment)
        let range = NSRange(location: 0, length: out.length)
        out.addAttributes([.replyCopyText: copy, .foregroundColor: color], range: range)
        if display {
            out.addAttribute(.replyMath, value: MathMark(size: size, attachment: attachment), range: range)
        }
        return out
    }
}

private extension ReplyFont {
    var withMonospacedDigits: ReplyFont {
        #if os(iOS)
        let d = fontDescriptor.addingAttributes([.featureSettings: [[
            UIFontDescriptor.FeatureKey.type: kNumberSpacingType,
            UIFontDescriptor.FeatureKey.selector: kMonospacedNumbersSelector]]])
        return UIFont(descriptor: d, size: pointSize)
        #else
        let d = fontDescriptor.addingAttributes([.featureSettings: [[
            NSFontDescriptor.FeatureKey.typeIdentifier: kNumberSpacingType,
            NSFontDescriptor.FeatureKey.selectorIdentifier: kMonospacedNumbersSelector]]])
        return NSFont(descriptor: d, size: pointSize) ?? self
        #endif
    }
}

// MARK: - Copy

enum ReplyCopy {
    /// The selection as plain text: formulas as TeX, markers as "• ", and a
    /// blank line between two blocks — as the text would be typed.
    static func plain(_ s: NSAttributedString, blockGap: CGFloat) -> String {
        var out = ""
        let ns = s.string as NSString
        var location = 0
        while location < ns.length {
            let paragraph = ns.paragraphRange(for: NSRange(location: location, length: 0))
            if location > 0, let ps = s.attribute(.paragraphStyle, at: location, effectiveRange: nil) as? NSParagraphStyle,
               ps.paragraphSpacingBefore >= blockGap {
                out += "\n"
            }
            s.enumerateAttribute(.replyCopyText, in: paragraph) { v, r, _ in
                out += (v as? String) ?? ns.substring(with: r)
            }
            location = NSMaxRange(paragraph)
        }
        return out.replacingOccurrences(of: "\u{2028}", with: "\n")
            .replacingOccurrences(of: "\u{FFFC}", with: "")
    }

    /// The selection as rich text a document can take: its weights and
    /// slants, but none of the theme's colours, which belong to this screen.
    static func rtf(_ s: NSAttributedString) -> Data? {
        let m = NSMutableAttributedString()
        let full = NSRange(location: 0, length: s.length)
        let ns = s.string as NSString
        s.enumerateAttributes(in: full) { attrs, r, _ in
            var a = attrs
            for k in [NSAttributedString.Key.foregroundColor, .backgroundColor, .replyCode, .replyQuote, .replyInlineCode,
                      .replyRule, .replyTableRow, .replyRecord, .replyMath, .replyCopyText, .attachment] {
                a.removeValue(forKey: k)
            }
            let text = (attrs[.replyCopyText] as? String) ?? ns.substring(with: r)
            m.append(NSAttributedString(string: text.replacingOccurrences(of: "\u{2028}", with: "\n"), attributes: a))
        }
        return try? m.data(from: NSRange(location: 0, length: m.length),
                           documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf])
    }
}

// MARK: - Drawing

/// One thing drawn behind the text: a filled shape, or a small label.
enum ReplyDecoration {
    case fill(CGRect, radius: CGFloat, color: ReplyColor)
    case label(NSAttributedString, at: CGPoint)
}

/// Works out, from the layout, what is drawn behind the glyphs: code panels
/// and their language, inline code, quote bars, table rules, horizontal rules.
/// The Mac draws them in the layout manager's background pass, under its
/// selection; on iOS the selection is drawn under the text, so they live in
/// a view beneath the text view's own (`ReplyDecorationView`).
final class ReplyLayoutManager: NSLayoutManager {
    var style: ReplyStyle?
    private var cached: (width: CGFloat, items: [ReplyDecoration])?

    /// Called whenever the text or its width changes.
    func invalidateDecorations() { cached = nil }

    func decorations(width: CGFloat) -> [ReplyDecoration] {
        if let cached, cached.width == width { return cached.items }
        guard let storage = textStorage, let style else { return [] }
        var out: [ReplyDecoration] = []
        let full = NSRange(location: 0, length: storage.length)
        let line = 1 / Self.scale
        let codeBg = style.color(style.codeBg)
        let rule = style.color(style.rule)

        // Code panels, and their language.
        storage.enumerateAttribute(.replyCode, in: full) { v, r, _ in
            guard let mark = v as? CodeMark else { return }
            let panel = codePanel(r, width: width, style: style)
            guard !panel.isNull else { return }
            out.append(.fill(panel, radius: 6, color: codeBg))
            if !mark.language.isEmpty {
                let label = NSAttributedString(string: mark.language, attributes: [
                    .font: style.font(size: 11, mono: true), .foregroundColor: style.color(style.inkMute)])
                let h = label.size().height
                out.append(.label(label, at: CGPoint(x: panel.minX + style.codePadH,
                                                     y: panel.minY + (style.codeHeader - h) / 2)))
            }
        }
        // Inline code: a soft box around each line's part of it, as tall as
        // its glyphs, not as its line.
        storage.enumerateAttribute(.replyInlineCode, in: full) { v, r, _ in
            guard v != nil, let container = textContainers.first else { return }
            let font = storage.attribute(.font, at: r.location, effectiveRange: nil) as? ReplyFont
            let ascender = font?.ascender ?? 12
            let descender = font?.descender ?? -3
            let glyphs = glyphRange(forCharacterRange: r, actualCharacterRange: nil)
            enumerateLineFragments(forGlyphRange: glyphs) { frag, _, _, lineGlyphs, _ in
                let part = NSIntersectionRange(glyphs, lineGlyphs)
                guard part.length > 0 else { return }
                let rect = self.boundingRect(forGlyphRange: part, in: container)
                let baseline = frag.minY + self.location(forGlyphAt: part.location).y
                out.append(.fill(CGRect(x: rect.minX - 2, y: baseline - ascender - 1,
                                        width: rect.width + 4, height: ascender - descender + 2),
                                 radius: 3, color: codeBg))
            }
        }
        // Quote bars, down the quote's paragraphs.
        storage.enumerateAttribute(.replyQuote, in: full) { v, range, _ in
            guard let mark = v as? QuoteMark else { return }
            // The trailing newline is part of the run, not a line of its own.
            var r = range
            if r.length > 1, (storage.string as NSString).character(at: NSMaxRange(r) - 1) == 10 { r.length -= 1 }
            let b = box(of: r)
            guard !b.isNull else { return }
            for x in mark.bars {
                out.append(.fill(CGRect(x: x, y: b.minY + 1, width: 3, height: b.height - 1 - style.lineSpacing / 2),
                                 radius: 0, color: rule))
            }
        }
        // Tables: the header's band first, the rules over it.
        var rules: [CGRect] = []
        storage.enumerateAttribute(.replyTableRow, in: full) { v, r, _ in
            guard let row = v as? TableRowMark else { return }
            let glyphs = glyphRange(forCharacterRange: r, actualCharacterRange: nil)
            var rect = CGRect.null
            enumerateLineFragments(forGlyphRange: glyphs) { frag, _, _, _, _ in rect = rect.union(frag) }
            guard !rect.isNull else { return }
            let top = rect.minY + row.skip
            let bottom = rect.maxY
            let left = row.edges.first ?? row.left
            let right = row.edges.last ?? width
            if row.header {
                out.append(.fill(CGRect(x: left, y: top, width: right - left, height: bottom - top), radius: 0, color: codeBg))
            }
            rules.append(CGRect(x: left, y: top, width: right - left, height: line))
            if row.last { rules.append(CGRect(x: left, y: bottom - line, width: right - left, height: line)) }
            for (i, x) in row.edges.enumerated() {
                rules.append(CGRect(x: i == row.edges.count - 1 ? x - line : x, y: top, width: line, height: bottom - top))
            }
        }
        storage.enumerateAttribute(.replyRecord, in: full) { v, r, _ in
            guard let left = (v as? NSNumber).map({ CGFloat($0.doubleValue) }) else { return }
            let b = box(of: r)
            guard !b.isNull else { return }
            rules.append(CGRect(x: left, y: (b.minY - style.gap / 2).rounded(), width: width - left, height: line))
        }
        storage.enumerateAttribute(.replyRule, in: full) { v, r, _ in
            guard let left = (v as? NSNumber).map({ CGFloat($0.doubleValue) }) else { return }
            let b = box(of: r)
            guard !b.isNull else { return }
            rules.append(CGRect(x: left, y: b.midY.rounded(), width: width - left, height: 1))
        }
        out += rules.map { .fill($0, radius: 0, color: rule) }
        cached = (width, out)
        return out
    }

    /// The union of the used rects of a character range's lines.
    func box(of range: NSRange) -> CGRect {
        let glyphs = glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        var r = CGRect.null
        enumerateLineFragments(forGlyphRange: glyphs) { _, used, _, _, _ in r = r.union(used) }
        return r
    }

    /// The panel's rect: from the band above the first line to the pad below
    /// the last, across the page.
    func codePanel(_ range: NSRange, width: CGFloat, style: ReplyStyle) -> CGRect {
        let b = box(of: range)
        guard !b.isNull else { return .null }
        let ps = textStorage?.attribute(.paragraphStyle, at: range.location, effectiveRange: nil) as? NSParagraphStyle
        let left = (ps?.headIndent ?? style.codePadH) - style.codePadH
        return CGRect(x: left, y: b.minY - style.codeHeader, width: width - left,
                      height: b.height + style.codeHeader + style.codePadBottom)
    }

    #if os(macOS)
    override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: CGPoint) {
        if let container = textContainers.first, let ctx = NSGraphicsContext.current?.cgContext {
            ctx.saveGState()
            ctx.translateBy(x: origin.x, y: origin.y)
            for d in decorations(width: container.size.width) {
                switch d {
                case .fill(let rect, let radius, let color):
                    ctx.setFillColor(color.cgColor)
                    ctx.addPath(CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil))
                    ctx.fillPath()
                case .label(let s, let p):
                    s.draw(at: p)
                }
            }
            ctx.restoreGState()
        }
        super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
    }

    /// The selection, see-through: the code panels and the table's header
    /// band stay visible under it, as they do on iOS.
    override func fillBackgroundRectArray(_ rectArray: UnsafePointer<NSRect>, count rectCount: Int,
                                          forCharacterRange charRange: NSRange, color: NSColor) {
        (color.usingColorSpace(.sRGB) ?? color).withAlphaComponent(0.55).setFill()
        for rect in UnsafeBufferPointer(start: rectArray, count: rectCount) { rect.fill(using: .sourceOver) }
    }
    #endif

    private static var scale: CGFloat {
        #if os(iOS)
        return UITraitCollection.current.displayScale > 0 ? UITraitCollection.current.displayScale : 2
        #else
        return NSScreen.main?.backingScaleFactor ?? 2
        #endif
    }
}

#if os(iOS)
/// The decorations, beneath a text view's text and its selection: shape
/// layers, one per colour, and labels — no bitmap the height of the message.
final class ReplyDecorationView: UIView {
    private var shapes: [CAShapeLayer] = []
    private var labels: [UILabel] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
    }
    required init?(coder: NSCoder) { fatalError("unused") }

    func show(_ decorations: [ReplyDecoration]) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        // One path per colour, in the order the colours first appear.
        var order: [ReplyColor] = []
        var paths: [ReplyColor: CGMutablePath] = [:]
        var texts: [(NSAttributedString, CGPoint)] = []
        for d in decorations {
            switch d {
            case .fill(let rect, let radius, let color):
                if paths[color] == nil { paths[color] = CGMutablePath(); order.append(color) }
                paths[color]?.addPath(CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil))
            case .label(let s, let p):
                texts.append((s, p))
            }
        }
        while shapes.count < order.count {
            let l = CAShapeLayer()
            layer.addSublayer(l)
            shapes.append(l)
        }
        for (i, l) in shapes.enumerated() {
            if i < order.count {
                l.isHidden = false
                l.fillColor = order[i].cgColor
                l.path = paths[order[i]]
            } else {
                l.isHidden = true
            }
        }
        while labels.count < texts.count {
            let l = UILabel()
            addSubview(l)
            labels.append(l)
        }
        for (i, l) in labels.enumerated() {
            if i < texts.count {
                l.isHidden = false
                l.attributedText = texts[i].0
                l.sizeToFit()
                l.frame.origin = texts[i].1
            } else {
                l.isHidden = true
            }
        }
        CATransaction.commit()
    }
}
#endif

// MARK: - The view

/// A menu entry a text adds to its selection menu (a shared room's Report and Block).
struct ReplyMenuItem {
    let title: String
    let systemImage: String
    var destructive = false
    let action: () -> Void
}

/// A message body: rich, and selectable from one end to the other.
struct ReplyText: View {
    let markdown: String
    /// Off while a reply streams in: the text is still moving.
    var selectable = true
    var menu: [ReplyMenuItem] = []
    @Environment(\.mauriceTheme) private var theme
    @Environment(\.openURL) private var openURL

    var body: some View {
        let doc = ReplyDocument.make(markdown, style: ReplyStyle(theme))
        VStack(alignment: .leading, spacing: (kBodyFont * 0.75).rounded()) {
            ForEach(Array(doc.pieces.enumerated()), id: \.offset) { _, piece in
                switch piece {
                case .text(let body):
                    ReplyTextRepresentable(body: body, selectable: selectable, menu: menu,
                                           openURL: { openURL($0) })
                case .paste(let text):
                    PastedTextCard(snippet: .paste(text), theme: theme)
                case .article(let article):
                    PastedTextCard(snippet: .article(article), theme: theme)
                }
            }
        }
    }
}

/// What both platforms' text views share: their text, its drawing, their
/// code blocks' copy buttons, and how tall they stand for a width.
private final class ReplyTextEngine {
    let storage = NSTextStorage()
    let layout = ReplyLayoutManager()
    let container = NSTextContainer(size: CGSize(width: 100, height: CGFloat.greatestFiniteMagnitude))
    private(set) var body: ReplyBody?
    private var shown: NSAttributedString?

    init() {
        container.lineFragmentPadding = 0
        container.widthTracksTextView = false
        container.heightTracksTextView = false
        storage.addLayoutManager(layout)
        layout.addTextContainer(container)
        layout.usesFontLeading = true
    }

    func set(_ body: ReplyBody) {
        guard body !== self.body else { return }
        self.body = body
        layout.style = body.style
        shown = nil
    }

    /// Lay the text out for a width; true when the text itself changed.
    @discardableResult
    func layOut(width: CGFloat) -> Bool {
        guard let body, width > 0, width.isFinite else { return false }
        var changed = false
        let s = body.attributed(width: width)
        if s !== shown {
            storage.setAttributedString(s)
            shown = s
            changed = true
        }
        // UITextView fits its container to its frame when it lays itself
        // out. Left that short, the container laid out only the lines that
        // fit, so a reply growing under the stream measured no taller than
        // the frame it had: the new lines went on below, under the composer,
        // until a change of width let the whole text through at once.
        if abs(container.size.width - width) > 0.25 || container.size.height < .greatestFiniteMagnitude {
            container.size = CGSize(width: width, height: .greatestFiniteMagnitude)
            changed = true
        }
        layout.ensureLayout(for: container)
        if changed { layout.invalidateDecorations() }
        return changed
    }

    /// The size for a proposed width: prose hugs its longest line (a short
    /// message keeps a small bubble); a code panel, a table or a rule takes
    /// the whole width, which it draws across.
    func size(proposed: CGFloat?) -> CGSize {
        // Asked how narrow it can be (a window's minimum size): as narrow as
        // it is given — a text wraps.
        if let proposed, proposed.isFinite, proposed < 40 { return CGSize(width: proposed, height: 0) }
        let width = proposed.flatMap { $0.isFinite ? $0 : nil } ?? 10_000
        layOut(width: width)
        let used = layout.usedRect(for: container)
        let height = ceil(used.maxY + (body?.bottomOverhang ?? 0))
        let full = NSRange(location: 0, length: storage.length)
        var spans = false
        for key in [NSAttributedString.Key.replyCode, .replyRule, .replyTableRow, .replyRecord] where !spans {
            storage.enumerateAttribute(key, in: full) { v, _, stop in
                if v != nil { spans = true; stop.pointee = true }
            }
        }
        if spans, width < 10_000 { return CGSize(width: width, height: height) }
        return CGSize(width: min(width, ceil(used.maxX)), height: height)
    }

    /// Where each code block's copy button goes, and what it copies.
    func codeButtons(width: CGFloat) -> [(frame: CGRect, code: String)] {
        guard let style = body?.style else { return [] }
        var out: [(CGRect, String)] = []
        storage.enumerateAttribute(.replyCode, in: NSRange(location: 0, length: storage.length)) { v, r, _ in
            guard let mark = v as? CodeMark else { return }
            let panel = layout.codePanel(r, width: width, style: style)
            guard !panel.isNull else { return }
            out.append((CGRect(x: panel.maxX - 84, y: panel.minY, width: 80, height: style.codeHeader), mark.code))
        }
        return out
    }
}

#if os(iOS)

private struct ReplyTextRepresentable: UIViewRepresentable {
    let body: ReplyBody
    let selectable: Bool
    let menu: [ReplyMenuItem]
    let openURL: (URL) -> Void

    func makeUIView(context: Context) -> ReplyUITextView { ReplyUITextView() }

    func updateUIView(_ view: ReplyUITextView, context: Context) {
        view.menuItems = menu
        view.openURL = openURL
        view.isSelectable = selectable
        view.show(body)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: ReplyUITextView, context: Context) -> CGSize? {
        uiView.show(body)
        return uiView.engine.size(proposed: proposal.width)
    }
}

final class ReplyUITextView: UITextView, UITextViewDelegate {
    fileprivate let engine = ReplyTextEngine()
    var menuItems: [ReplyMenuItem] = []
    var openURL: ((URL) -> Void)?
    private var buttons: [CodeCopyButton] = []
    private let decorations = ReplyDecorationView()

    init() {
        super.init(frame: .zero, textContainer: engine.container)
        insertSubview(decorations, at: 0)
        isEditable = false
        isSelectable = true
        isScrollEnabled = false
        backgroundColor = .clear
        textContainerInset = .zero
        dataDetectorTypes = []
        delegate = self
        clipsToBounds = false
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        setContentHuggingPriority(.defaultLow, for: .horizontal)
    }
    required init?(coder: NSCoder) { fatalError("unused") }

    fileprivate func show(_ body: ReplyBody) {
        let changed = body !== engine.body
        engine.set(body)
        linkTextAttributes = [
            .foregroundColor: body.style.color(body.style.ink),
            .underlineStyle: NSUnderlineStyle.single.rawValue,
            .underlineColor: body.style.color(body.style.inkMute)]
        if changed {
            setNeedsLayout()
            invalidateIntrinsicContentSize()
        }
    }

    override func layoutSubviews() {
        if bounds.width > 0, engine.layOut(width: bounds.width) {
            setNeedsDisplay()
        }

        super.layoutSubviews()
        // Beneath the text and its selection, whatever UIKit added since.
        sendSubviewToBack(decorations)
        decorations.frame = bounds
        decorations.show(engine.layout.decorations(width: bounds.width))
        placeButtons()
    }

    private func placeButtons() {
        let wanted = engine.codeButtons(width: bounds.width)
        while buttons.count < wanted.count {
            let b = CodeCopyButton()
            addSubview(b)
            buttons.append(b)
        }
        for (i, b) in buttons.enumerated() {
            if i < wanted.count {
                b.isHidden = false
                b.frame = wanted[i].frame
                b.code = wanted[i].code
                if let style = engine.body?.style { b.tint(style.color(style.inkMute)) }
            } else {
                b.isHidden = true
            }
        }
    }

    // Plain text with formulas as TeX, and rich text without the theme's colours.
    override func copy(_ sender: Any?) {
        let r = selectedRange
        guard r.length > 0 else { return }
        let sub = textStorage.attributedSubstring(from: r)
        var item: [String: Any] = [UTType.utf8PlainText.identifier: ReplyCopy.plain(sub, blockGap: engine.body?.style.gap ?? 12)]
        if let rtf = ReplyCopy.rtf(sub) { item[UTType.rtf.identifier] = rtf }
        UIPasteboard.general.setItems([item])
    }

    func textView(_ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction) -> UIAction? {
        guard case .link(let url) = textItem.content, let openURL else { return defaultAction }
        return UIAction { _ in openURL(url) }
    }

    func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
        guard !menuItems.isEmpty else { return nil }
        let extra = menuItems.map { item in
            UIAction(title: item.title, image: UIImage(systemName: item.systemImage),
                     attributes: item.destructive ? .destructive : []) { _ in item.action() }
        }
        return UIMenu(children: suggestedActions + [UIMenu(options: .displayInline, children: extra)])
    }

    func textViewDidChangeSelection(_ textView: UITextView) {
        if selectedRange.length > 0 { TapAway.shared.watch(self) }
    }
}

/// A tap anywhere but on the selected text lets its selection go, as on a
/// page: one recognizer per window, watching the text that holds a selection.
private final class TapAway: NSObject, UIGestureRecognizerDelegate {
    static let shared = TapAway()
    private weak var current: ReplyUITextView?

    func watch(_ view: ReplyUITextView) {
        current = view
        guard let window = view.window,
              !(window.gestureRecognizers ?? []).contains(where: { $0.delegate === self }) else { return }
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
        tap.cancelsTouchesInView = false
        tap.delegate = self
        window.addGestureRecognizer(tap)
    }

    @objc private func tapped(_ g: UITapGestureRecognizer) {
        guard let view = current, view.selectedRange.length > 0,
              !view.bounds.contains(g.location(in: view)) else { return }
        // After the tap's own action: a tap on the menu's Copy copies first.
        DispatchQueue.main.async {
            guard view.selectedRange.length > 0 else { return }
            view.selectedRange = NSRange(location: view.selectedRange.location, length: 0)
            _ = view.resignFirstResponder()
        }
    }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}

/// "Copy", then "Copied" for a moment.
private final class CodeCopyButton: UIButton {
    var code = ""
    private var color: UIColor = .secondaryLabel

    init() {
        super.init(frame: .zero)
        contentHorizontalAlignment = .trailing
        addTarget(self, action: #selector(copyCode), for: .touchUpInside)
        setLabel(copied: false)
    }
    required init?(coder: NSCoder) { fatalError("unused") }

    func tint(_ c: UIColor) {
        guard c != color else { return }
        color = c
        setLabel(copied: false)
    }

    private func setLabel(copied: Bool) {
        var config = UIButton.Configuration.plain()
        config.image = UIImage(systemName: copied ? "checkmark" : "doc.on.doc",
                               withConfiguration: UIImage.SymbolConfiguration(pointSize: 10))
        config.imagePadding = 4
        config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 4, bottom: 0, trailing: 4)
        var title = AttributedString(copied ? L("chat.copied") : L("chat.copy"))
        title.font = .systemFont(ofSize: 11)
        config.attributedTitle = title
        config.baseForegroundColor = color
        configuration = config
    }

    @objc private func copyCode() {
        copyToPasteboard(code)
        setLabel(copied: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.setLabel(copied: false) }
    }
}

#else

private struct ReplyTextRepresentable: NSViewRepresentable {
    let body: ReplyBody
    let selectable: Bool
    let menu: [ReplyMenuItem]
    let openURL: (URL) -> Void

    func makeNSView(context: Context) -> ReplyNSTextView { ReplyNSTextView() }

    func updateNSView(_ view: ReplyNSTextView, context: Context) {
        view.menuItems = menu
        view.openURL = openURL
        view.isSelectable = selectable
        view.show(body)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: ReplyNSTextView, context: Context) -> CGSize? {
        nsView.show(body)
        return nsView.engine.size(proposed: proposal.width)
    }
}

final class ReplyNSTextView: NSTextView, NSTextViewDelegate {
    fileprivate let engine = ReplyTextEngine()
    var menuItems: [ReplyMenuItem] = []
    var openURL: ((URL) -> Void)?
    private var buttons: [CodeCopyButton] = []

    init() {
        super.init(frame: .zero, textContainer: engine.container)
        isEditable = false
        isSelectable = true
        isRichText = true
        drawsBackground = false
        textContainerInset = .zero
        isVerticallyResizable = false
        isHorizontallyResizable = false
        isAutomaticLinkDetectionEnabled = false
        delegate = self
    }
    override init(frame: NSRect, textContainer: NSTextContainer?) { super.init(frame: frame, textContainer: textContainer) }
    required init?(coder: NSCoder) { fatalError("unused") }

    override var isFlipped: Bool { true }

    fileprivate func show(_ body: ReplyBody) {
        let changed = body !== engine.body
        engine.set(body)
        linkTextAttributes = [
            .foregroundColor: body.style.color(body.style.ink),
            .underlineStyle: NSUnderlineStyle.single.rawValue,
            .underlineColor: body.style.color(body.style.inkMute),
            .cursor: NSCursor.pointingHand]
        if changed {
            needsLayout = true
            if frame.width > 0, engine.layOut(width: frame.width) { needsDisplay = true }
            placeButtons()
        }
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        if newSize.width > 0, engine.layOut(width: newSize.width) { needsDisplay = true }
        placeButtons()
    }

    override func layout() {
        super.layout()
        placeButtons()
    }

    private func placeButtons() {
        guard frame.width > 0 else { return }
        let wanted = engine.codeButtons(width: frame.width)
        while buttons.count < wanted.count {
            let b = CodeCopyButton()
            addSubview(b)
            buttons.append(b)
        }
        for (i, b) in buttons.enumerated() {
            if i < wanted.count {
                b.isHidden = false
                b.code = wanted[i].code
                if let style = engine.body?.style { b.tint(style.color(style.inkMute)) }
                let size = b.fittingSize
                let band = wanted[i].frame
                b.frame = CGRect(x: band.maxX - size.width, y: band.midY - size.height / 2,
                                 width: size.width, height: size.height)
            } else {
                b.isHidden = true
            }
        }
    }

    override func writeSelection(to pboard: NSPasteboard, types: [NSPasteboard.PasteboardType]) -> Bool {
        let r = selectedRange()
        guard r.length > 0, let storage = textStorage else { return false }
        let sub = storage.attributedSubstring(from: r)
        pboard.clearContents()
        pboard.setString(ReplyCopy.plain(sub, blockGap: engine.body?.style.gap ?? 12), forType: .string)
        if let rtf = ReplyCopy.rtf(sub) { pboard.setData(rtf, forType: .rtf) }
        return true
    }

    func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
        let url = (link as? URL) ?? (link as? String).flatMap(URL.init(string:))
        guard let url, let openURL else { return false }
        openURL(url)
        return true
    }

    func textView(_ view: NSTextView, menu: NSMenu, for event: NSEvent, at charIndex: Int) -> NSMenu? {
        // Keep what applies to a read-only text: copy, look up, share, speech.
        let editing: Set<String> = ["cut:", "paste:", "pasteAsPlainText:", "pasteAsRichText:"]
        for item in menu.items where item.action.map({ editing.contains(NSStringFromSelector($0)) }) == true {
            menu.removeItem(item)
        }
        if !menuItems.isEmpty {
            menu.addItem(.separator())
            for entry in menuItems {
                let item = ClosureMenuItem(title: entry.title, action: entry.action)
                item.image = NSImage(systemSymbolName: entry.systemImage, accessibilityDescription: nil)
                menu.addItem(item)
            }
        }
        return menu
    }

    // Clicking into one message's text lets the last one's selection go.
    override func resignFirstResponder() -> Bool {
        setSelectedRange(NSRange(location: selectedRange().location, length: 0))
        return super.resignFirstResponder()
    }
}

private final class ClosureMenuItem: NSMenuItem {
    private let run: () -> Void
    init(title: String, action: @escaping () -> Void) {
        run = action
        super.init(title: title, action: #selector(fire), keyEquivalent: "")
        target = self
    }
    required init(coder: NSCoder) { fatalError("unused") }
    @objc private func fire() { run() }
}

/// "Copy", then "Copied" for a moment.
private final class CodeCopyButton: NSButton {
    var code = ""
    private var color: NSColor = .secondaryLabelColor

    init() {
        super.init(frame: .zero)
        isBordered = false
        imagePosition = .imageLeading
        imageHugsTitle = true
        target = self
        action = #selector(copyCode)
        setLabel(copied: false)
    }
    required init?(coder: NSCoder) { fatalError("unused") }

    func tint(_ c: NSColor) {
        guard c != color else { return }
        color = c
        setLabel(copied: false)
    }

    private func setLabel(copied: Bool) {
        let config = NSImage.SymbolConfiguration(pointSize: 10, weight: .regular)
        image = NSImage(systemSymbolName: copied ? "checkmark" : "doc.on.doc", accessibilityDescription: nil)?
            .withSymbolConfiguration(config)
        contentTintColor = color
        attributedTitle = NSAttributedString(string: copied ? L("chat.copied") : L("chat.copy"), attributes: [
            .font: NSFont.systemFont(ofSize: 11), .foregroundColor: color])
        toolTip = L("chat.copy")
    }

    @objc private func copyCode() {
        copyToPasteboard(code)
        setLabel(copied: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.setLabel(copied: false) }
    }
}

#endif

#if DEBUG
enum ReplyBenchmark {
    /// What one step of a streaming reply costs: parse, build, lay out — for
    /// each prefix of `markdown`, every `step` characters.
    static func run(_ markdown: String, style: ReplyStyle, width: CGFloat, step: Int = 3) -> String {
        let engine = ReplyTextEngine()
        var n = 0
        var worst: Double = 0
        let start = CFAbsoluteTimeGetCurrent()
        var i = step
        while i <= markdown.count {
            let t = CFAbsoluteTimeGetCurrent()
            let doc = ReplyDocument.make(String(markdown.prefix(i)), style: style)
            for case .text(let body) in doc.pieces {
                engine.set(body)
                _ = engine.size(proposed: width)
            }
            worst = max(worst, CFAbsoluteTimeGetCurrent() - t)
            n += 1
            i += step
        }
        let total = CFAbsoluteTimeGetCurrent() - start
        return String(format: "%d chars, %d steps, mean %.2f ms, worst %.2f ms", markdown.count, n, total / Double(n) * 1000, worst * 1000)
    }
}
#endif
