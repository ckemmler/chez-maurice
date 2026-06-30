// dialog.jsx — EditMemberDialog, extended with the new "Conversation history"
// (Import conversations) section below Model access. Trimmed from settings-app.jsx
// (no App / AccessMatrix / render) so the demo can host it directly. The only
// change vs. the shipped dialog is the <ImportConversations> body block + the
// `importSeed` pass-through the demo uses to jump between states.

const COLORS = ['#a6452e', '#b97a1e', '#b5a13a', '#3d6b4f', '#2c5aa0', '#5b4b8a', '#9c5a7a', '#4f7a78', '#2a2622'];

function shortName(m) {
  if (m.tier === 'cloud') return m.name.replace(/^Claude\s+/, '');
  return m.name.split(' ').slice(0, 2).join(' ');
}

function EditMemberDialog({ member, models, access, isNew, importSeed, embedded, onClose, onSave, onToggleAccess }) {
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

  const card = (
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

            {/* hairline divider before the new disclosure block */}
            <div style={{ height: 0.5, background: TH.rule, margin: '0 -20px' }} />

            {/* ── NEW: Conversation history / Import conversations ── */}
            <ImportConversations key={importSeed} member={member} seed={importSeed} />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 20px', borderTop: `0.5px solid ${TH.rule}`, background: TH.surfaceAlt }}>
            <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
            <Btn kind="primary" onClick={() => onSave({ ...member, name, handle, color, prompt })}>{isNew ? 'Add member' : 'Save changes'}</Btn>
          </div>
        </Card>
      </div>
  );

  if (embedded) return card;
  return (
    <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(38,35,32,0.40)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '6vh 20px 40px', overflowY: 'auto' }}>
      {card}
    </div>
  );
}

Object.assign(window, { EditMemberDialog, COLORS, shortName });
