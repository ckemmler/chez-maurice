// settings-app.jsx — the members×models access matrix, the Edit-member dialog,
// and the web App shell that lays out all four sections.

const COLORS = ['#a6452e', '#b97a1e', '#b5a13a', '#3d6b4f', '#2c5aa0', '#5b4b8a', '#9c5a7a', '#4f7a78', '#2a2622'];

function shortName(m) {
  if (m.tier === 'cloud') return m.name.replace(/^Claude\s+/, '');
  return m.name.split(' ').slice(0, 2).join(' ');
}

// ── cell toggle ──────────────────────────────────────────────────────────────
function Cell({ on, tier, locked, onClick }) {
  const color = tier === 'local' ? TH.ok : TH.cloud;
  return (
    <button onClick={locked ? undefined : onClick} title={locked ? 'Admins can use every model' : (on ? 'Allowed — click to revoke' : 'Click to allow')}
      style={{ all: 'unset', cursor: locked ? 'default' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', height: 44 }}>
      <span style={{
        width: 26, height: 26, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: on ? color : 'transparent',
        boxShadow: on ? 'none' : `inset 0 0 0 1px ${TH.ruleHard}`,
        color: '#fff', opacity: locked && on ? 0.55 : 1,
      }}>
        {on
          ? (locked ? <I.lock s={12} /> : <I.check s={15} />)
          : <span style={{ width: 5, height: 5, borderRadius: 3, background: TH.ruleHard }} />}
      </span>
    </button>
  );
}

// ── 4 · access matrix ─────────────────────────────────────────────────────────
function AccessMatrix({ members, models, access, defaultModel, onToggle, onSetMemberAll }) {
  const colW = 88;
  const nameW = 208;
  const groups = [
    { tier: 'cloud', label: 'Cloud · metered', items: models.filter((m) => m.tier === 'cloud') },
    { tier: 'local', label: 'On-device · private', items: models.filter((m) => m.tier === 'local') },
  ];
  return (
    <section>
      <SectionHead kicker="04 · Access" title="Who can use what"
        desc="Allow each member the models they should reach. Kids are kept to on-device and Haiku by default — no metered frontier models without a tap." />
      <Card style={{ overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: nameW + groups.reduce((a, g) => a + g.items.length * colW, 0) }}>
            {/* group header */}
            <div style={{ display: 'flex', borderBottom: `0.5px solid ${TH.rule}` }}>
              <div style={{ width: nameW, flexShrink: 0 }} />
              {groups.map((g) => (
                <div key={g.tier} style={{
                  width: g.items.length * colW, flexShrink: 0, padding: '10px 0 8px', textAlign: 'center',
                  borderLeft: `0.5px solid ${TH.rule}`,
                  fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase',
                  color: g.tier === 'local' ? TH.ok : TH.cloud,
                }}>{g.label}</div>
              ))}
            </div>
            {/* model header */}
            <div style={{ display: 'flex', borderBottom: `0.5px solid ${TH.ruleHard}`, background: TH.surfaceAlt }}>
              <div style={{ width: nameW, flexShrink: 0, display: 'flex', alignItems: 'flex-end', padding: '0 0 9px 18px', fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: TH.inkMute }}>Member</div>
              {groups.map((g) => g.items.map((m, i) => {
                const isDefault = m.id === defaultModel;
                return (
                  <div key={m.id} style={{ width: colW, flexShrink: 0, padding: '9px 4px 8px', textAlign: 'center', borderLeft: `0.5px solid ${i === 0 ? TH.rule : TH.rule}` }}>
                    {isDefault && <div title="Household default" style={{ color: TH.caution, marginBottom: 2, display: 'flex', justifyContent: 'center' }}>
                      <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor"><path d="M6 1l1.5 3 3.3.3-2.5 2.2.8 3.2L6 8.1 2.9 9.9l.8-3.2L1.2 4.3 4.5 4z"/></svg>
                    </div>}
                    <div style={{ fontFamily: SANS, fontSize: 11.5, fontWeight: 600, color: TH.ink, lineHeight: 1.2 }}>{shortName(m)}</div>
                    <div style={{ fontFamily: MONO, fontSize: 9, color: TH.inkMute, marginTop: 3 }}>{m.tier === 'local' ? `${m.ram}GB` : `${m.ctx}k`}</div>
                  </div>
                );
              }))}
            </div>
            {/* rows */}
            {members.map((mem, ri) => {
              const allowed = access[mem.id] || [];
              const admin = mem.role === 'admin';
              return (
                <div key={mem.id} style={{ display: 'flex', borderTop: ri ? `0.5px solid ${TH.rule}` : 'none', alignItems: 'stretch' }}>
                  <div style={{ width: nameW, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 11, padding: '0 14px' }}>
                    <Avatar m={mem} size={30} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontFamily: SANS, fontSize: 13.5, fontWeight: 600, color: TH.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mem.name}</div>
                      <div style={{ fontFamily: MONO, fontSize: 9.5, color: admin ? TH.accent : TH.inkMute }}>{admin ? 'admin · all' : `${allowed.length} models`}</div>
                    </div>
                  </div>
                  {groups.map((g) => g.items.map((m) => (
                    <div key={m.id} style={{ width: colW, flexShrink: 0, borderLeft: `0.5px solid ${TH.rule}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Cell on={admin || allowed.includes(m.id)} tier={m.tier} locked={admin} onClick={() => onToggle(mem.id, m.id)} />
                    </div>
                  )))}
                </div>
              );
            })}
          </div>
        </div>
      </Card>
      <div style={{ fontFamily: MONO, fontSize: 10.5, color: TH.inkMute, marginTop: 12, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 12, height: 12, borderRadius: 4, background: TH.cloud }} /> cloud allowed</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 12, height: 12, borderRadius: 4, background: TH.ok }} /> on-device allowed</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ color: TH.caution, display: 'flex' }}><svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor"><path d="M6 1l1.5 3 3.3.3-2.5 2.2.8 3.2L6 8.1 2.9 9.9l.8-3.2L1.2 4.3 4.5 4z"/></svg></span> household default</span>
      </div>
    </section>
  );
}

// ── edit member dialog ────────────────────────────────────────────────────────
function EditMemberDialog({ member, models, access, isNew, onClose, onSave, onToggleAccess }) {
  const [name, setName] = sS(member.name || '');
  const [handle, setHandle] = sS(member.handle || '');
  const [color, setColor] = sS(member.color || COLORS[0]);
  const [prompt, setPrompt] = sS(member.prompt || '');
  const [pin, setPin] = sS('');
  const admin = member.role === 'admin';
  const allowed = access[member.id] || [];

  sE(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const cloud = models.filter((m) => m.tier === 'cloud');
  const local = models.filter((m) => m.tier === 'local');

  const AccessChip = ({ m }) => {
    const on = admin || allowed.includes(m.id);
    const color2 = m.tier === 'local' ? TH.ok : TH.cloud;
    return (
      <button onClick={admin ? undefined : () => onToggleAccess(member.id, m.id)} style={{
        all: 'unset', cursor: 'default', display: 'inline-flex', alignItems: 'center', gap: 7,
        padding: '6px 11px 6px 9px', borderRadius: 999,
        background: on ? (m.tier === 'local' ? TH.okSoft : TH.cloudSoft) : 'transparent',
        boxShadow: `inset 0 0 0 0.5px ${on ? color2 + '55' : TH.ruleHard}`, opacity: admin ? 0.7 : 1,
      }}>
        <span style={{ width: 15, height: 15, borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center', background: on ? color2 : 'transparent', color: '#fff', boxShadow: on ? 'none' : `inset 0 0 0 1px ${TH.ruleHard}` }}>
          {on && (admin ? <I.lock s={9} /> : <I.check s={11} />)}
        </span>
        <span style={{ fontFamily: SANS, fontSize: 12.5, color: TH.ink, fontWeight: on ? 500 : 400 }}>{shortName(m)}</span>
      </button>
    );
  };

  return (
    <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(38,35,32,0.40)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '6vh 20px 40px', overflowY: 'auto' }}>
      <div onMouseDown={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 540 }}>
        <Card style={{ overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '17px 20px', borderBottom: `0.5px solid ${TH.rule}` }}>
            {!isNew && <Avatar m={member} size={34} />}
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: MONO, fontSize: 9.5, color: TH.inkMute, letterSpacing: '0.12em', textTransform: 'uppercase' }}>{isNew ? 'New member' : 'Edit member'}</div>
              <div style={{ fontFamily: SERIF, fontSize: 21, color: TH.ink, letterSpacing: '-0.01em', lineHeight: 1.1 }}>{name || 'Untitled'}</div>
            </div>
            <button onClick={onClose} style={{ all: 'unset', cursor: 'default', color: TH.inkMute, padding: 6 }}><I.x s={15} /></button>
          </div>

          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div className="two-col" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <Field label="Display name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="Handle" suffix={<span style={{ fontFamily: MONO, fontSize: 11, color: TH.inkMute }}>@</span>}>
                <Input value={handle} mono onChange={(e) => setHandle(e.target.value.replace(/[^a-z0-9]/g, ''))} />
              </Field>
            </div>

            <Field label="Color">
              <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
                {COLORS.map((c) => (
                  <button key={c} onClick={() => setColor(c)} style={{
                    all: 'unset', cursor: 'default', width: 28, height: 28, borderRadius: 14, background: c,
                    boxShadow: color === c ? `0 0 0 2px ${TH.surface}, 0 0 0 3.5px ${c}` : 'inset 0 0 0 0.5px rgba(0,0,0,0.18)',
                  }} />
                ))}
              </div>
            </Field>

            <Field label="PIN" hint='Leave blank to keep · type "clear" to remove'>
              <Input value={pin} placeholder={member.pin ? '•••• (set)' : 'no PIN'} mono onChange={(e) => setPin(e.target.value)} />
            </Field>

            <Field label="Profile / system prompt">
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="Who is this person? Maurice uses this to tailor its replies…"
                style={{ ...inputStyle(), resize: 'vertical', minHeight: 92, lineHeight: 1.5 }} />
            </Field>

            <div>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 9 }}>
                <span style={{ fontFamily: SANS, fontSize: 12.5, fontWeight: 500, color: TH.ink }}>Model access</span>
                <span style={{ fontFamily: MONO, fontSize: 10, color: admin ? TH.accent : TH.inkMute }}>{admin ? 'admin · every model' : `${allowed.length} of ${models.length}`}</span>
              </div>
              <div style={{ fontFamily: MONO, fontSize: 9, color: TH.cloud, letterSpacing: '0.06em', textTransform: 'uppercase', margin: '0 0 7px' }}>Cloud</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>{cloud.map((m) => <AccessChip key={m.id} m={m} />)}</div>
              <div style={{ fontFamily: MONO, fontSize: 9, color: TH.ok, letterSpacing: '0.06em', textTransform: 'uppercase', margin: '0 0 7px' }}>On-device</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{local.map((m) => <AccessChip key={m.id} m={m} />)}</div>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 20px', borderTop: `0.5px solid ${TH.rule}`, background: TH.surfaceAlt }}>
            <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
            <Btn kind="primary" onClick={() => onSave({ ...member, name, handle, color, prompt })}>{isNew ? 'Add member' : 'Save changes'}</Btn>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ── App ────────────────────────────────────────────────────────────────────────
function App() {
  const [members, setMembers] = sS(MEMBERS);
  const [models, setModels] = sS(MODELS);
  const [ollama, setOllama] = sS(OLLAMA);
  const [household, setHousehold] = sS(HOUSEHOLD);
  const [access, setAccess] = sS(ACCESS);
  const [editing, setEditing] = sS(null);   // member | {new}
  const [isNew, setIsNew] = sS(false);
  const [toast, setToast] = sS(false);

  const showToast = () => { setToast(true); setTimeout(() => setToast(false), 2600); };

  const accessCount = sM(() => {
    const c = {};
    models.forEach((m) => { c[m.id] = members.filter((mem) => mem.role === 'admin' || (access[mem.id] || []).includes(m.id)).length; });
    return c;
  }, [models, members, access]);

  const toggle = (memberId, modelId) => setAccess((a) => {
    const cur = a[memberId] || [];
    return { ...a, [memberId]: cur.includes(modelId) ? cur.filter((x) => x !== modelId) : [...cur, modelId] };
  });

  const addModel = (mdl) => { setModels((ms) => ms.some((m) => m.id === mdl.id) ? ms : [...ms, mdl]); showToast(); };
  const removeModel = (mdl) => { setModels((ms) => ms.filter((m) => m.id !== mdl.id)); setAccess((a) => { const n = {}; Object.keys(a).forEach((k) => n[k] = a[k].filter((x) => x !== mdl.id)); return n; }); };
  const rescan = () => setOllama((o) => ({ ...o, lastScan: 'just now' }));

  const openEdit = (m) => { setEditing(m); setIsNew(false); };
  const openNew = () => { setEditing({ id: 'm-' + Date.now(), name: '', handle: '', role: 'standard', pin: false, color: COLORS[0], avatar: 'avatars/candide-sq.png' }); setIsNew(true); };
  const saveMember = (m) => {
    setMembers((arr) => arr.some((x) => x.id === m.id) ? arr.map((x) => x.id === m.id ? m : x) : [...arr, m]);
    if (isNew) setAccess((a) => ({ ...a, [m.id]: a[m.id] || ['claude-haiku-4-6'] }));
    setEditing(null); showToast();
  };
  const deleteMember = (m) => { setMembers((arr) => arr.filter((x) => x.id !== m.id)); };

  return (
    <div style={{ minHeight: '100vh', background: TH.bg, color: TH.ink }}>
      {/* top nav */}
      <div style={{ position: 'sticky', top: 0, zIndex: 50, background: 'rgba(236,227,212,0.86)', backdropFilter: 'blur(10px)', borderBottom: `0.5px solid ${TH.rule}` }}>
        <div style={{ maxWidth: 1000, margin: '0 auto', padding: '0 24px', height: 58, display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, color: TH.ink }}>
            <span style={{ width: 26, height: 26, borderRadius: 8, background: TH.ink, color: '#f5efe6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: SERIF, fontSize: 15 }}>M</span>
            <span style={{ fontFamily: SERIF, fontSize: 19, letterSpacing: '-0.01em' }}>Chez Maurice</span>
          </span>
          <span style={{ width: 0.5, height: 22, background: TH.ruleHard, margin: '0 4px' }} />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: TH.inkSoft }}>
            <I.cog s={16} /><span style={{ fontFamily: SANS, fontSize: 14, fontWeight: 500 }}>Settings</span>
          </span>
          <div style={{ flex: 1 }} />
          <span style={{ fontFamily: MONO, fontSize: 11, color: TH.inkMute }}>admin · {members.find((m) => m.role === 'admin')?.name.toLowerCase()}</span>
        </div>
      </div>

      {/* toast */}
      {toast && (
        <div style={{ position: 'fixed', top: 70, left: '50%', transform: 'translateX(-50%)', zIndex: 60, display: 'flex', alignItems: 'center', gap: 9, background: TH.okSoft, color: TH.ok, border: `0.5px solid ${TH.ok}55`, borderRadius: 999, padding: '8px 16px', fontFamily: SANS, fontSize: 13, fontWeight: 500, boxShadow: '0 8px 30px rgba(38,35,32,0.12)' }}>
          <I.check s={14} /> Settings saved
        </div>
      )}

      <div style={{ maxWidth: 1000, margin: '0 auto', padding: '40px 24px 90px', display: 'flex', flexDirection: 'column', gap: 46 }}>
        <header>
          <h1 style={{ margin: 0, fontFamily: SERIF, fontSize: 40, letterSpacing: '-0.02em', fontWeight: 400, lineHeight: 1 }}>Settings</h1>
          <p style={{ margin: '10px 0 0', fontFamily: SANS, fontSize: 15, color: TH.inkSoft, maxWidth: 560, lineHeight: 1.5 }}>
            Manage the household, the models Maurice can run — cloud or on your own Mac mini — and who’s allowed to reach each one.
          </p>
        </header>

        <MembersSection members={members} onEdit={openEdit} onDelete={deleteMember} onAdd={openNew} />
        <AISection household={household} models={models} onChange={(p) => setHousehold((h) => ({ ...h, ...p }))} onSave={showToast} />
        <ModelsSection models={models} ollama={ollama} accessCount={accessCount} memberCount={members.length}
          onRescan={rescan} onAddModel={addModel} onRemoveModel={removeModel} />
        <AccessMatrix members={members} models={models} access={access} defaultModel={household.defaultModel} onToggle={toggle} />
      </div>

      {editing && (
        <EditMemberDialog member={editing} models={models} access={access} isNew={isNew}
          onClose={() => setEditing(null)} onSave={saveMember} onToggleAccess={toggle} />
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
