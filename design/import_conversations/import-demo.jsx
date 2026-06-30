// import-demo.jsx — a focused reference for the new "Import conversations" flow.
// Renders the real EditMemberDialog (embedded) with a state switcher across the
// six states, plus the proposed member-row status chip in context. Not the
// shipping app — a spec surface, same conventions as the settings prototype.

const STATES = [
  { k: 'empty',    n: '01', l: 'Empty',    d: 'First Anthropic export · full archive' },
  { k: 'selected', n: '02', l: 'Selected', d: 'Sync scope + privacy confirm' },
  { k: 'running',  n: '03', l: 'Running',  d: 'Upload → parse → index' },
  { k: 'success',  n: '04', l: 'Success',  d: 'Run appended · watermark advances' },
  { k: 'imported', n: '05', l: 'Synced',   d: 'Run log + watermark · sync newer' },
  { k: 'error',    n: '06', l: 'Error',    d: 'Partial / bad file · non-destructive' },
];

function Switcher({ value, onChange }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
      {STATES.map((s) => {
        const on = s.k === value;
        return (
          <button key={s.k} onClick={() => onChange(s.k)} style={{
            all: 'unset', cursor: 'default', display: 'flex', alignItems: 'center', gap: 8,
            padding: '7px 12px', borderRadius: 999,
            background: on ? TH.ink : TH.surface, color: on ? '#fbf7f0' : TH.ink,
            boxShadow: on ? 'none' : `inset 0 0 0 0.5px ${TH.ruleHard}`,
          }}>
            <span style={{ fontFamily: MONO, fontSize: 10, opacity: on ? 0.7 : 0.5 }}>{s.n}</span>
            <span style={{ fontFamily: SANS, fontSize: 12.5, fontWeight: 500 }}>{s.l}</span>
          </button>
        );
      })}
    </div>
  );
}

// faithful mini members card showing the proposed row chip in context
function RowChipDemo() {
  const rows = [
    { m: MEMBERS.find((x) => x.id === 'candide'), chip: <ImportChip phase="imported" />, sub: 'synced through 14 Jun 2026' },
    { m: MEMBERS.find((x) => x.id === 'paola'), chip: <ImportChip phase="indexing" done={29} total={41} />, sub: 'syncing now — admin can watch from here' },
    { m: MEMBERS.find((x) => x.id === 'adriano'), chip: null, sub: 'no Anthropic export imported' },
  ];
  return (
    <Card style={{ overflow: 'hidden' }}>
      {rows.map((r, i) => (
        <div key={r.m.id} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '12px 18px', borderTop: i ? `0.5px solid ${TH.rule}` : 'none' }}>
          <Avatar m={r.m} size={34} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: SANS, fontSize: 14.5, fontWeight: 600, color: TH.ink }}>{r.m.name}</div>
            <div style={{ fontFamily: MONO, fontSize: 10.5, color: TH.inkMute, marginTop: 1 }}>{r.sub}</div>
          </div>
          {r.chip}
        </div>
      ))}
    </Card>
  );
}

function Note({ kicker, children }) {
  return (
    <div>
      <div style={{ fontFamily: MONO, fontSize: 9.5, color: TH.inkMute, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 6 }}>{kicker}</div>
      <p style={{ margin: 0, fontFamily: SANS, fontSize: 13, color: TH.inkSoft, lineHeight: 1.6 }}>{children}</p>
    </div>
  );
}

function DemoApp() {
  const [state, setState] = sS('empty');
  const member = MEMBERS.find((x) => x.id === 'paola');  // standard member: admin importing on their behalf
  const [access, setAccess] = sS(ACCESS);
  const toggle = (memberId, modelId) => setAccess((a) => {
    const cur = a[memberId] || [];
    return { ...a, [memberId]: cur.includes(modelId) ? cur.filter((x) => x !== modelId) : [...cur, modelId] };
  });

  return (
    <div style={{ minHeight: '100vh', background: TH.bg, color: TH.ink }}>
      {/* top nav — same chrome as Settings */}
      <div style={{ position: 'sticky', top: 0, zIndex: 50, background: 'rgba(236,227,212,0.88)', backdropFilter: 'blur(10px)', borderBottom: `0.5px solid ${TH.rule}` }}>
        <div style={{ maxWidth: 980, margin: '0 auto', padding: '0 24px', height: 56, display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
            <span style={{ width: 26, height: 26, borderRadius: 8, background: TH.ink, color: '#f5efe6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: SERIF, fontSize: 15 }}>M</span>
            <span style={{ fontFamily: SERIF, fontSize: 19, letterSpacing: '-0.01em' }}>Chez Maurice</span>
          </span>
          <span style={{ width: 0.5, height: 22, background: TH.ruleHard, margin: '0 4px' }} />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: TH.inkSoft }}>
            <I.cog s={16} /><span style={{ fontFamily: SANS, fontSize: 14, fontWeight: 500 }}>Settings</span>
          </span>
          <div style={{ flex: 1 }} />
          <span style={{ fontFamily: MONO, fontSize: 11, color: TH.inkMute }}>reference · anthropic data export</span>
        </div>
      </div>

      <div style={{ maxWidth: 980, margin: '0 auto', padding: '40px 24px 96px' }}>
        {/* spec header */}
        <header style={{ marginBottom: 26 }}>
          <div style={{ fontFamily: MONO, fontSize: 10.5, color: TH.inkMute, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 9 }}>Member fiche · Anthropic data export</div>
          <h1 style={{ margin: 0, fontFamily: SERIF, fontSize: 40, letterSpacing: '-0.02em', fontWeight: 400, lineHeight: 1.02 }}>Import from Claude</h1>
          <p style={{ margin: '12px 0 0', fontFamily: SANS, fontSize: 15, color: TH.inkSoft, maxWidth: 640, lineHeight: 1.55 }}>
            A per-member flow inside <strong style={{ fontWeight: 500, color: TH.ink }}>Edit member</strong>, below Model access. Upload that person's <strong style={{ fontWeight: 500, color: TH.ink }}>Anthropic data export</strong> so their past Claude conversations become searchable by Maurice — in <em style={{ fontFamily: SERIF, fontStyle: 'italic' }}>their</em> private index, alongside the household's books. An export is a full snapshot, so each run records its date range and advances a <em style={{ fontFamily: SERIF, fontStyle: 'italic' }}>sync watermark</em>; the next import pulls only what's new. Switch states to walk the machine.
          </p>
        </header>

        {/* state switcher */}
        <div style={{ position: 'sticky', top: 56, zIndex: 40, padding: '14px 0 16px', background: 'linear-gradient(to bottom, rgba(236,227,212,0.96) 72%, rgba(236,227,212,0))', marginBottom: 4 }}>
          <Switcher value={state} onChange={setState} />
          <div style={{ fontFamily: MONO, fontSize: 10.5, color: TH.inkMute, marginTop: 9 }}>
            {STATES.find((s) => s.k === state).n} · {STATES.find((s) => s.k === state).l} — {STATES.find((s) => s.k === state).d}
          </div>
        </div>

        {/* layout: the dialog + side notes */}
        <div className="demo-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 540px) 1fr', gap: 34, alignItems: 'start' }}>
          <div>
            <EditMemberDialog
              key={member.id}
              member={member}
              models={MODELS}
              access={access}
              isNew={false}
              embedded
              importSeed={state}
              onClose={() => {}}
              onSave={() => {}}
              onToggleAccess={toggle}
            />
            <div style={{ fontFamily: MONO, fontSize: 10, color: TH.inkMute, marginTop: 12, textAlign: 'center' }}>
              ↑ the real EditMemberDialog (embedded) · scroll to the “Anthropic data export” block
            </div>
          </div>

          <aside style={{ display: 'flex', flexDirection: 'column', gap: 22, position: 'sticky', top: 132 }}>
            <Note kicker="Anthropic export, named honestly">
              The section is titled <strong style={{ fontWeight: 500, color: TH.ink }}>Anthropic data export</strong> and the drop zone asks for the data-export <span style={{ fontFamily: MONO, fontSize: 12 }}>.zip</span> specifically — so an admin doesn't try a random file. A bad file is rejected with “doesn't look like an Anthropic data export.”
            </Note>
            <Note kicker="Incremental sync + watermark">
              Each run logs the <strong style={{ fontWeight: 500, color: TH.ink }}>date range</strong> of conversations it added; the latest successful <span style={{ fontFamily: MONO, fontSize: 12 }}>to</span> is the watermark (“Last synced through 31&nbsp;May&nbsp;2026”). The returning state shows the run log + watermark; the next import is framed as a sync from there — only conversations after it.
            </Note>
            <Note kicker="Placement">
              A collapsible <strong style={{ fontWeight: 500, color: TH.ink }}>disclosure</strong> — the dialog is already tall, so it stays folded with a live status line (“synced through 31&nbsp;May”, “indexing 29/41”). Auto-opens while a job runs or on error.
            </Note>
            <Note kicker="Non-destructive">
              A failed or interrupted sync is logged as <strong style={{ fontWeight: 500, color: TH.ink }}>partial</strong> and leaves the prior history + watermark untouched. Green = synced/searchable; marigold = the privacy consent gate.
            </Note>

            <div>
              <div style={{ fontFamily: MONO, fontSize: 9.5, color: TH.inkMute, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 11 }}>Recommended · row chip in MembersSection</div>
              <RowChipDemo />
              <p style={{ margin: '11px 0 0', fontFamily: SANS, fontSize: 12.5, color: TH.inkSoft, lineHeight: 1.55 }}>
                Worth it: a long sync shouldn't require opening the fiche to see it's alive. A compact mono chip on the member row mirrors the dialog status — admin glances, no click.
              </p>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<DemoApp />);
