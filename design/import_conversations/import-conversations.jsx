// import-conversations.jsx — "Anthropic data export" section for EditMemberDialog.
// Imports a member's Anthropic (Claude.ai) account data export — the .zip from
// Claude.ai's privacy settings (conversations.json + projects/ + design_chats/) —
// so their past Claude conversations become semantically searchable by Maurice
// (joins the member's PRIVATE index, alongside the household's books).
//
// An export is a full snapshot at export time, so we import INCREMENTALLY: every
// run records the date range it covered and advances a last-sync WATERMARK. The
// fiche shows the run log + watermark and frames the next import as a sync from
// that watermark. One body block in the dialog, below "Model access". Reuses
// TH / SANS / MONO / I from settings-core. `seed` lets a demo jump to a state.

// ── extra hairline icons (match I's 16-viewbox, ~1.4 stroke) ──────────────────
const IX = {
  chevron: (p) => <svg width={p?.s || 13} height={p?.s || 13} viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  zip: (p) => <svg width={p?.s || 16} height={p?.s || 16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"><path d="M4 1.6h5.2L13 5.3V14a.8.8 0 0 1-.8.8H4a.8.8 0 0 1-.8-.8V2.4A.8.8 0 0 1 4 1.6z"/><path d="M9 1.8V5h3.4" strokeLinecap="round"/><path d="M6.4 4.2h1.1M6.4 6h1.1M6.4 7.8h1.1" strokeLinecap="round"/></svg>,
  upload: (p) => <svg width={p?.s || 18} height={p?.s || 18} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13V4M6.4 7.2L10 3.6l3.6 3.6"/><path d="M3.5 12.5V15a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5v-2.5"/></svg>,
  search: (p) => <svg width={p?.s || 14} height={p?.s || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2L14 14"/></svg>,
  alert: (p) => <svg width={p?.s || 14} height={p?.s || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2.2l6 10.6H2z"/><path d="M8 6.6v3M8 11.4v.05"/></svg>,
  clock: (p) => <svg width={p?.s || 13} height={p?.s || 13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 4.8V8l2.2 1.4"/></svg>,
  shield: (p) => <svg width={p?.s || 14} height={p?.s || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round"><path d="M8 1.8l5 1.8v3.6c0 3.2-2.1 5.6-5 6.6-2.9-1-5-3.4-5-6.6V3.6z"/><path d="M5.8 8.1l1.5 1.5 3-3.2" strokeLinecap="round"/></svg>,
  sync: (p) => <svg width={p?.s || 14} height={p?.s || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M2.6 8a5.4 5.4 0 0 1 9.2-3.8l1.7 1.6"/><path d="M13.4 8a5.4 5.4 0 0 1-9.2 3.8l-1.7-1.6"/><path d="M13.9 2.2v3.6h-3.6"/><path d="M2.1 13.8v-3.6h3.6"/></svg>,
};

// ── fixtures the seed states use ──────────────────────────────────────────────
const SAMPLE_FILE = { name: 'anthropic-data-export.zip', size: '19.8 MB', estConv: 1000 };
const fmt = (n) => n.toLocaleString('en-US');

// each entry = one import run. watermark = latest successful run's `to`.
const HISTORY = [
  { id: 'imp_2', from: '9 Mar 2026', to: '31 May 2026', conv: 118, msg: 1486, ran: '31 May 2026 · 08:12', status: 'done' },
  { id: 'imp_1', from: 'May 2024',  to: '8 Mar 2026',  conv: 870, msg: 9251, ran: '8 Mar 2026 · 19:40',  status: 'done' },
];
const WATERMARK = '31 May 2026';
const SYNC_ENTRY    = { id: 'imp_3',  from: '31 May 2026', to: '14 Jun 2026', conv: 41, msg: 503, ran: 'just now', status: 'done' };
const PARTIAL_ENTRY = { id: 'imp_3p', from: '31 May 2026', to: '—',           conv: 18, msg: 214, ran: 'just now', status: 'partial' };

function seedState(seed) {
  switch (seed) {
    case 'selected': return { phase: 'selected', file: SAMPLE_FILE, withProjects: false, confirmed: false, mode: 'sync', watermark: WATERMARK, history: HISTORY };
    case 'running':  return { phase: 'indexing', file: SAMPLE_FILE, withProjects: false, mode: 'first', done: 412, total: 1029, sent: 100, history: [] };
    case 'success':  return { phase: 'success', mode: 'sync', watermark: '14 Jun 2026', appended: SYNC_ENTRY, history: [SYNC_ENTRY, ...HISTORY] };
    case 'imported': return { phase: 'imported', history: HISTORY, watermark: WATERMARK };
    case 'error':    return { phase: 'error', errKind: 'partial', history: [PARTIAL_ENTRY, ...HISTORY], watermark: WATERMARK, done: 18, total: 41 };
    default:         return { phase: 'empty', file: null, withProjects: false };
  }
}

// small building blocks ───────────────────────────────────────────────────────
function Toggle({ on, onClick }) {
  return (
    <button onClick={onClick} role="switch" aria-checked={on} style={{
      all: 'unset', cursor: 'default', flexShrink: 0, width: 34, height: 20, borderRadius: 999,
      background: on ? TH.ink : TH.inset, boxShadow: `inset 0 0 0 0.5px ${on ? TH.ink : TH.ruleHard}`,
      position: 'relative', transition: 'background 140ms ease',
    }}>
      <span style={{
        position: 'absolute', top: 2.5, left: on ? 16.5 : 2.5, width: 15, height: 15, borderRadius: 999,
        background: TH.surface, boxShadow: '0 1px 2px rgba(38,35,32,0.28)', transition: 'left 140ms ease',
      }} />
    </button>
  );
}

function ProjectsToggle({ on, onClick }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11, padding: '11px 13px', borderRadius: 10, background: TH.inset, boxShadow: `inset 0 0 0 0.5px ${TH.rule}` }}>
      <Toggle on={on} onClick={onClick} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: SANS, fontSize: 12.5, fontWeight: 500, color: TH.ink }}>Also import projects &amp; design chats</div>
        <div style={{ fontFamily: MONO, fontSize: 10, color: TH.inkMute, marginTop: 2 }}>The export's <span style={{ color: TH.inkSoft }}>projects/</span> &amp; <span style={{ color: TH.inkSoft }}>design_chats/</span> — off by default. Conversations import either way.</div>
      </div>
    </div>
  );
}

// prominent sync-watermark line ───────────────────────────────────────────────
function Watermark({ date }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 14px', borderRadius: 11, background: TH.okSoft, boxShadow: `inset 0 0 0 0.5px ${TH.ok}33` }}>
      <span style={{ width: 30, height: 30, borderRadius: 9, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: TH.surface, color: TH.ok, boxShadow: `inset 0 0 0 0.5px ${TH.ok}33` }}><IX.sync s={15} /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: MONO, fontSize: 9, color: TH.inkMute, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Sync watermark</div>
        <div style={{ fontFamily: SANS, fontSize: 13.5, fontWeight: 600, color: TH.ink, marginTop: 1 }}>Last synced through <span style={{ fontFamily: MONO, fontSize: 12.5 }}>{date}</span></div>
      </div>
    </div>
  );
}

function RunStatus({ status }) {
  const map = { done: { c: TH.ok, l: 'done' }, partial: { c: TH.caution, l: 'partial' }, failed: { c: TH.accent, l: 'failed' } };
  const s = map[status] || map.done;
  return <span style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: s.c, background: s.c + '1f', padding: '2px 7px', borderRadius: 5, whiteSpace: 'nowrap' }}>{s.l}</span>;
}

// the run log — newest first, reads like a sync timeline ───────────────────────
function HistoryList({ entries, highlight }) {
  const dot = (status) => status === 'partial' ? TH.caution : status === 'failed' ? TH.accent : TH.ok;
  return (
    <div style={{ borderRadius: 11, background: TH.surfaceAlt, boxShadow: `inset 0 0 0 0.5px ${TH.rule}`, overflow: 'hidden' }}>
      <div style={{ maxHeight: 184, overflowY: 'auto', padding: '2px 13px' }}>
        {entries.map((e, i) => (
          <div key={e.id} style={{ display: 'flex', gap: 11, padding: '10px 0', borderTop: i ? `0.5px solid ${TH.rule}` : 'none', background: highlight === e.id ? 'transparent' : 'transparent' }}>
            <span style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0, marginTop: 4, background: dot(e.status), boxShadow: highlight === e.id ? `0 0 0 3px ${dot(e.status)}22` : 'none' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ fontFamily: MONO, fontSize: 11, color: TH.ink, fontWeight: 500, whiteSpace: 'nowrap' }}>{e.from} <span style={{ color: TH.inkMute }}>→</span> {e.to}</span>
                <span style={{ fontFamily: MONO, fontSize: 10, color: TH.inkMute, whiteSpace: 'nowrap' }}>{fmt(e.conv)} conv · {fmt(e.msg)} msg</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 4 }}>
                <span style={{ fontFamily: MONO, fontSize: 9.5, color: TH.inkMute }}>ran {e.ran}</span>
                <RunStatus status={e.status} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// phase stepper for the running state ─────────────────────────────────────────
function Stepper({ phase }) {
  const order = ['uploading', 'parsing', 'indexing'];
  const steps = [{ k: 'uploading', l: 'Upload' }, { k: 'parsing', l: 'Parse' }, { k: 'indexing', l: 'Index' }];
  const cur = order.indexOf(phase);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {steps.map((s, i) => {
        const state = i < cur ? 'done' : i === cur ? 'now' : 'next';
        const col = state === 'done' ? TH.ok : state === 'now' ? TH.ok : TH.inkMute;
        return (
          <React.Fragment key={s.k}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                width: 15, height: 15, borderRadius: 999, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: state === 'done' ? TH.ok : 'transparent', color: '#fff',
                boxShadow: state === 'done' ? 'none' : `inset 0 0 0 1px ${state === 'now' ? TH.ok : TH.ruleHard}`,
              }}>
                {state === 'done' ? <I.check s={9} /> : <span style={{ width: 5, height: 5, borderRadius: 3, background: state === 'now' ? TH.ok : TH.ruleHard, animation: state === 'now' ? 'icPulse 1.1s ease-in-out infinite' : 'none' }} />}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: col, fontWeight: state === 'now' ? 500 : 400 }}>{s.l}</span>
            </span>
            {i < steps.length - 1 && <span style={{ width: 16, height: 0.5, background: i < cur ? TH.ok : TH.ruleHard }} />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function Bar({ pct, indeterminate }) {
  return (
    <span style={{ display: 'block', height: 6, borderRadius: 3, background: TH.inset, boxShadow: `inset 0 0 0 0.5px ${TH.rule}`, overflow: 'hidden', position: 'relative' }}>
      {indeterminate
        ? <span style={{ position: 'absolute', top: 0, left: 0, height: '100%', width: '38%', borderRadius: 3, background: TH.ok, animation: 'icSlide 1.25s ease-in-out infinite' }} />
        : <span style={{ display: 'block', height: '100%', width: `${Math.max(2, pct)}%`, borderRadius: 3, background: TH.ok, transition: 'width 160ms linear' }} />}
    </span>
  );
}

// the section ─────────────────────────────────────────────────────────────────
function ImportConversations({ member, seed = 'empty', defaultOpen = true }) {
  const [open, setOpen] = sS(defaultOpen);
  const [st, setSt] = sS(() => seedState(seed));
  const fileRef = sR(null);
  const who = member.name || 'this member';
  const runs = (st.history || []).length;

  // ── live transitions (also drive the demo animation) ──
  sE(() => {
    if (st.phase === 'uploading') {
      if ((st.sent || 0) >= 100) { const t = setTimeout(() => setSt((s) => ({ ...s, phase: 'parsing' })), 320); return () => clearTimeout(t); }
      const t = setTimeout(() => setSt((s) => ({ ...s, sent: Math.min(100, (s.sent || 0) + 11) })), 95); return () => clearTimeout(t);
    }
    if (st.phase === 'parsing') { const t = setTimeout(() => setSt((s) => ({ ...s, phase: 'indexing', done: 0, total: s.mode === 'sync' ? 41 : 1029 })), 1500); return () => clearTimeout(t); }
    if (st.phase === 'indexing') {
      if (st.done >= st.total) {
        const t = setTimeout(() => setSt((s) => {
          const entry = s.mode === 'sync'
            ? { id: 'imp_new', from: s.watermark || '31 May 2026', to: '14 Jun 2026', conv: s.total, msg: Math.round(s.total * 12.2), ran: 'just now', status: 'done' }
            : { id: 'imp_new', from: 'May 2024', to: '14 Jun 2026', conv: s.total, msg: Math.round(s.total * 10.9), ran: 'just now', status: 'done' };
          return { ...s, phase: 'success', appended: entry, watermark: '14 Jun 2026', history: [entry, ...(s.history || [])] };
        }), 260);
        return () => clearTimeout(t);
      }
      const t = setTimeout(() => setSt((s) => ({ ...s, done: Math.min(s.total, s.done + Math.ceil(s.total / 36)) })), 110); return () => clearTimeout(t);
    }
  }, [st.phase, st.sent, st.done]);

  const pick = (mode = 'first', ctx = {}) => setSt({ phase: 'selected', file: SAMPLE_FILE, withProjects: false, confirmed: false, mode, watermark: ctx.watermark, history: ctx.history || [] });
  const reset = () => setSt({ phase: 'empty', file: null, withProjects: false });
  const start = () => setSt((s) => ({ ...s, phase: 'uploading', sent: 0 }));
  const retry = () => setSt((s) => ({ ...s, phase: 'uploading', sent: 0, file: SAMPLE_FILE, confirmed: true, history: (s.history || []).filter((e) => e.status === 'done') }));
  const backToHistory = () => setSt((s) => (s.history && s.history.length) ? { phase: 'imported', history: s.history, watermark: s.watermark } : { phase: 'empty', file: null, withProjects: false });

  const running = ['uploading', 'parsing', 'indexing'].includes(st.phase);
  const syncMode = st.mode === 'sync';

  // header status meta (visible even when collapsed) ──
  const meta = (() => {
    if (running) {
      const dot = <span style={{ width: 6, height: 6, borderRadius: 3, background: TH.ok, animation: 'icPulse 1.1s ease-in-out infinite' }} />;
      const label = st.phase === 'indexing' ? `indexing ${fmt(st.done)}/${fmt(st.total)}` : st.phase === 'parsing' ? 'parsing…' : 'uploading…';
      return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: TH.ok }}>{dot}{label}</span>;
    }
    if (st.phase === 'success') return <span style={{ color: TH.ok }}>synced · just now</span>;
    if (st.phase === 'imported') return <span style={{ color: TH.inkSoft }}>synced through {st.watermark}</span>;
    if (st.phase === 'error') return <span style={{ color: st.errKind === 'badfile' ? TH.accent : TH.caution }}>{st.errKind === 'badfile' ? 'unrecognized file' : 'sync incomplete'}</span>;
    if (st.phase === 'selected') return <span style={{ color: TH.inkSoft }}>{syncMode ? 'ready to sync' : '1 file ready'}</span>;
    return <span style={{ color: TH.inkMute }}>not imported</span>;
  })();

  return (
    <div>
      {/* disclosure header — matches the "Model access" label rhythm */}
      <button onClick={() => setOpen((o) => !o)} style={{ all: 'unset', cursor: 'default', display: 'flex', alignItems: 'center', gap: 10, width: '100%', marginBottom: open ? 11 : 0 }}>
        <span style={{ display: 'flex', color: TH.inkMute, transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform 140ms ease' }}><IX.chevron s={13} /></span>
        <span style={{ fontFamily: SANS, fontSize: 12.5, fontWeight: 500, color: TH.ink }}>Anthropic data export</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: MONO, fontSize: 10, display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap' }}>{meta}</span>
      </button>

      {open && (
        <div>
          {/* EMPTY ─────────────────────────────────────────────── */}
          {st.phase === 'empty' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
              <p style={{ margin: 0, fontFamily: SANS, fontSize: 12.5, color: TH.inkSoft, lineHeight: 1.55 }}>
                Import {who}'s Claude.ai conversation history from an <strong style={{ fontWeight: 500, color: TH.ink }}>Anthropic data export</strong> — the <span style={{ fontFamily: MONO, fontSize: 11.5 }}>.zip</span> from Claude.ai's privacy settings. It's indexed into {who}'s private Maurice search, alongside the household's books. The first import covers their whole archive; later ones sync only what's new.
              </p>
              <input ref={fileRef} type="file" accept=".zip" style={{ display: 'none' }} onChange={() => pick('first')} />
              <label htmlFor="" onClick={(e) => { e.preventDefault(); pick('first'); }}
                onDragOver={(e) => { e.preventDefault(); e.currentTarget.dataset.drag = '1'; }}
                onDragLeave={(e) => { e.currentTarget.dataset.drag = ''; }}
                onDrop={(e) => { e.preventDefault(); e.currentTarget.dataset.drag = ''; pick('first'); }}
                className="ic-drop"
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 9,
                  padding: '26px 18px', borderRadius: 12, cursor: 'default', textAlign: 'center',
                  background: TH.inset, border: `1px dashed ${TH.ruleHard}`,
                }}>
                <span style={{ width: 40, height: 40, borderRadius: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', background: TH.surface, color: TH.inkSoft, boxShadow: `inset 0 0 0 0.5px ${TH.ruleHard}` }}><IX.upload s={19} /></span>
                <div>
                  <div style={{ fontFamily: SANS, fontSize: 13, color: TH.ink, fontWeight: 500 }}>Drop the Anthropic export here, or <span style={{ color: TH.accent }}>choose a file</span></div>
                  <div style={{ fontFamily: MONO, fontSize: 10, color: TH.inkMute, marginTop: 4 }}>data-export .zip · Claude.ai → Settings → Privacy → Export data · ~20 MB</div>
                </div>
              </label>
              <ProjectsToggle on={st.withProjects} onClick={() => setSt((s) => ({ ...s, withProjects: !s.withProjects }))} />
            </div>
          )}

          {/* SELECTED / PRE-CONFIRM ────────────────────────────── */}
          {st.phase === 'selected' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 11, background: TH.inset, boxShadow: `inset 0 0 0 0.5px ${TH.ruleHard}` }}>
                <span style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: TH.inkSoft, background: TH.surface, boxShadow: `inset 0 0 0 0.5px ${TH.ruleHard}` }}><IX.zip s={17} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, color: TH.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{st.file.name}</div>
                  <div style={{ fontFamily: MONO, fontSize: 10.5, color: TH.inkMute, marginTop: 2 }}>{st.file.size} · {syncMode ? `new conversations since ${st.watermark}` : `≈${fmt(st.file.estConv)} conversations`}</div>
                </div>
                <button onClick={syncMode ? backToHistory : reset} title="Remove" style={{ all: 'unset', cursor: 'default', color: TH.inkMute, display: 'flex', padding: 5 }}><I.x s={13} /></button>
              </div>

              {/* sync scope — what this run will actually pull in */}
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '0 2px' }}>
                <span style={{ display: 'flex', flexShrink: 0, marginTop: 1, color: syncMode ? TH.ok : TH.inkMute }}>{syncMode ? <IX.sync s={13} /> : <IX.upload s={13} />}</span>
                <span style={{ fontFamily: MONO, fontSize: 10, color: TH.inkSoft, lineHeight: 1.5 }}>
                  {syncMode
                    ? <>Imports only conversations <strong style={{ fontWeight: 500, color: TH.ink }}>after {st.watermark}</strong> — {who}'s earlier history stays indexed. Duplicates are skipped.</>
                    : <>First import — covers {who}'s <strong style={{ fontWeight: 500, color: TH.ink }}>full Claude.ai archive</strong>. Sets the sync watermark for next time.</>}
                </span>
              </div>

              <ProjectsToggle on={st.withProjects} onClick={() => setSt((s) => ({ ...s, withProjects: !s.withProjects }))} />

              {/* privacy confirmation — marigold caution */}
              <div style={{ display: 'flex', gap: 11, padding: '12px 13px', borderRadius: 11, background: TH.cautionSoft, boxShadow: `inset 0 0 0 0.5px ${TH.caution}33` }}>
                <span style={{ color: TH.caution, flexShrink: 0, display: 'flex', marginTop: 1 }}><IX.shield s={15} /></span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: SANS, fontSize: 12, color: TH.ink, lineHeight: 1.5 }}>
                    This ingests <strong style={{ fontWeight: 500 }}>{who}'s</strong> personal Claude history into their private index. Nobody else in the household can search it.
                  </div>
                  <button onClick={() => setSt((s) => ({ ...s, confirmed: !s.confirmed }))} style={{ all: 'unset', cursor: 'default', display: 'flex', alignItems: 'center', gap: 8, marginTop: 9 }}>
                    <span style={{ width: 17, height: 17, borderRadius: 5, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: st.confirmed ? TH.caution : 'transparent', color: '#fff', boxShadow: st.confirmed ? 'none' : `inset 0 0 0 1px ${TH.caution}66` }}>{st.confirmed && <I.check s={11} />}</span>
                    <span style={{ fontFamily: SANS, fontSize: 12, color: TH.ink, fontWeight: 500 }}>I have {who}'s go-ahead to import their history.</span>
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9 }}>
                <Btn kind="ghost" size="sm" onClick={syncMode ? backToHistory : reset}>Cancel</Btn>
                <Btn kind="primary" size="sm" disabled={!st.confirmed} onClick={start}>{syncMode ? 'Sync newer conversations' : 'Import full archive'}</Btn>
              </div>
            </div>
          )}

          {/* RUNNING ───────────────────────────────────────────── */}
          {running && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 13, padding: '15px 15px 14px', borderRadius: 12, background: TH.inset, boxShadow: `inset 0 0 0 0.5px ${TH.rule}` }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <Stepper phase={st.phase} />
                <span style={{ fontFamily: MONO, fontSize: 10.5, color: TH.inkSoft }}>
                  {st.phase === 'uploading' ? `${Math.round((st.sent / 100) * 19.8 * 10) / 10} / 19.8 MB` : st.phase === 'parsing' ? 'reading conversations…' : `${Math.round((st.done / st.total) * 100)}%`}
                </span>
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 7 }}>
                  <span style={{ fontFamily: SANS, fontSize: 12.5, color: TH.ink, fontWeight: 500 }}>
                    {st.phase === 'uploading' ? 'Uploading export' : st.phase === 'parsing' ? 'Parsing the archive' : `Indexing ${fmt(st.done)} of ${fmt(st.total)} ${syncMode ? 'new ' : ''}conversations`}
                  </span>
                  {st.phase === 'indexing' && <span style={{ fontFamily: MONO, fontSize: 10, color: TH.inkMute }}>embedding chunks</span>}
                </div>
                <Bar pct={st.phase === 'uploading' ? st.sent : (st.done / st.total) * 100} indeterminate={st.phase === 'parsing'} />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 7, fontFamily: MONO, fontSize: 10, color: TH.inkMute, flex: '1 1 240px' }}>
                  <span style={{ display: 'flex', flexShrink: 0, marginTop: 1 }}><IX.clock s={12} /></span>
                  <span>Keeps running if you close this — reopen {who}'s fiche to check in.</span>
                </span>
                <Btn kind="ghost" size="sm" onClick={backToHistory}>Cancel sync</Btn>
              </div>
            </div>
          )}

          {/* SUCCESS ───────────────────────────────────────────── */}
          {st.phase === 'success' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 14px', borderRadius: 11, background: TH.okSoft, boxShadow: `inset 0 0 0 0.5px ${TH.ok}33` }}>
                <span style={{ width: 32, height: 32, borderRadius: 9, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: TH.ok, color: '#fff' }}><IX.search s={15} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: SANS, fontSize: 13.5, fontWeight: 600, color: TH.ink }}>Search is ready</div>
                  <div style={{ fontFamily: MONO, fontSize: 10.5, color: TH.inkSoft, marginTop: 2 }}>Synced through {st.watermark} · {fmt(st.appended.conv)} {st.mode === 'sync' ? 'new ' : ''}conversations · {fmt(st.appended.msg)} messages added</div>
                </div>
              </div>
              <div>
                <div style={{ fontFamily: MONO, fontSize: 9.5, color: TH.inkMute, letterSpacing: '0.1em', textTransform: 'uppercase', margin: '2px 0 8px' }}>Import history · {runs} {runs === 1 ? 'run' : 'runs'}</div>
                <HistoryList entries={st.history} highlight={st.appended.id} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Btn kind="ghost" size="sm" icon={<IX.sync s={12} />} onClick={() => pick('sync', { watermark: st.watermark, history: st.history })}>Sync again</Btn>
              </div>
            </div>
          )}

          {/* IMPORTED / RETURNING ──────────────────────────────── */}
          {st.phase === 'imported' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
              <Watermark date={st.watermark} />
              <div>
                <div style={{ fontFamily: MONO, fontSize: 9.5, color: TH.inkMute, letterSpacing: '0.1em', textTransform: 'uppercase', margin: '0 0 8px' }}>Import history · {runs} {runs === 1 ? 'run' : 'runs'}</div>
                <HistoryList entries={st.history} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: MONO, fontSize: 10, color: TH.inkMute, flex: '1 1 220px', lineHeight: 1.45 }}>A new export imports only conversations after {st.watermark} — earlier ones stay indexed.</span>
                <div style={{ display: 'flex', gap: 9 }}>
                  <Btn kind="danger" size="sm" onClick={reset}>Remove</Btn>
                  <Btn kind="primary" size="sm" icon={<IX.sync s={13} />} onClick={() => pick('sync', { watermark: st.watermark, history: st.history })}>Sync newer conversations</Btn>
                </div>
              </div>
            </div>
          )}

          {/* ERROR / PARTIAL ───────────────────────────────────── */}
          {st.phase === 'error' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* demo: flip between the two error flavours the brief calls out */}
              <div style={{ display: 'inline-flex', alignSelf: 'flex-start', gap: 2, padding: 2, borderRadius: 8, background: TH.inset, boxShadow: `inset 0 0 0 0.5px ${TH.rule}` }}>
                {[{ k: 'partial', l: 'Partial sync' }, { k: 'badfile', l: 'Unrecognized file' }].map((o) => {
                  const on = st.errKind === o.k;
                  return <button key={o.k} onClick={() => setSt((s) => ({ ...s, errKind: o.k }))} style={{ all: 'unset', cursor: 'default', fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.04em', textTransform: 'uppercase', padding: '4px 9px', borderRadius: 6, color: on ? TH.ink : TH.inkMute, background: on ? TH.surface : 'transparent', boxShadow: on ? `inset 0 0 0 0.5px ${TH.ruleHard}` : 'none' }}>{o.l}</button>;
                })}
              </div>

              {st.errKind === 'badfile' ? (
                <React.Fragment>
                  <div style={{ display: 'flex', gap: 11, padding: '13px 14px', borderRadius: 11, background: TH.accentSoft, boxShadow: `inset 0 0 0 0.5px ${TH.accent}33` }}>
                    <span style={{ color: TH.accent, flexShrink: 0, display: 'flex', marginTop: 1 }}><IX.alert s={16} /></span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, color: TH.ink }}>This doesn't look like an Anthropic data export</div>
                      <div style={{ fontFamily: SANS, fontSize: 12, color: TH.inkSoft, lineHeight: 1.5, marginTop: 3 }}>
                        Maurice needs the <span style={{ fontFamily: MONO, fontSize: 11.5 }}>conversations.json</span> a Claude.ai export contains. Download the data-export <span style={{ fontFamily: MONO, fontSize: 11.5 }}>.zip</span> from Claude.ai → Settings → Privacy → Export data, then drop it here.
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9 }}>
                    <Btn kind="ghost" size="sm" onClick={reset}>Dismiss</Btn>
                    <Btn kind="primary" size="sm" icon={<IX.upload s={13} />} onClick={() => pick('first')}>Choose another file</Btn>
                  </div>
                </React.Fragment>
              ) : (
                <React.Fragment>
                  <div style={{ display: 'flex', gap: 11, padding: '13px 14px', borderRadius: 11, background: TH.cautionSoft, boxShadow: `inset 0 0 0 0.5px ${TH.caution}40` }}>
                    <span style={{ color: TH.caution, flexShrink: 0, display: 'flex', marginTop: 1 }}><IX.alert s={16} /></span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, color: TH.ink }}>Sync incomplete — recorded as partial</div>
                      <div style={{ fontFamily: SANS, fontSize: 12, color: TH.inkSoft, lineHeight: 1.5, marginTop: 3 }}>
                        Indexed {fmt(st.done)} of {fmt(st.total)} new conversations before it stopped. {who}'s history and the <span style={{ fontFamily: MONO, fontSize: 11.5 }}>{st.watermark}</span> watermark are unchanged — nothing was lost. The partial run is logged below; retry to finish it.
                      </div>
                    </div>
                  </div>
                  <div>
                    <div style={{ fontFamily: MONO, fontSize: 9.5, color: TH.inkMute, letterSpacing: '0.1em', textTransform: 'uppercase', margin: '0 0 8px' }}>Import history · {runs} {runs === 1 ? 'run' : 'runs'}</div>
                    <HistoryList entries={st.history} highlight={st.history[0] && st.history[0].id} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9 }}>
                    <Btn kind="ghost" size="sm" onClick={backToHistory}>Dismiss</Btn>
                    <Btn kind="primary" size="sm" icon={<I.refresh s={12} />} onClick={retry}>Retry sync</Btn>
                  </div>
                </React.Fragment>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── bonus: compact status chip for a member row in MembersSection ─────────────
function ImportChip({ phase, done, total }) {
  if (phase === 'indexing' || phase === 'uploading' || phase === 'parsing') {
    const pct = phase === 'indexing' && total ? Math.round((done / total) * 100) : null;
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: MONO, fontSize: 10, color: TH.ok, background: TH.okSoft, padding: '3px 9px', borderRadius: 999 }}>
        <span style={{ width: 6, height: 6, borderRadius: 3, background: TH.ok, animation: 'icPulse 1.1s ease-in-out infinite' }} />
        {pct != null ? `syncing ${pct}%` : 'syncing…'}
      </span>
    );
  }
  if (phase === 'imported' || phase === 'success') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: MONO, fontSize: 10, color: TH.ok, background: TH.okSoft, padding: '3px 9px', borderRadius: 999 }}>
        <I.check s={11} /> synced
      </span>
    );
  }
  return null;
}

Object.assign(window, { ImportConversations, ImportChip, IX });
