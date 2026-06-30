// settings-core.jsx — Chez Maurice Settings (web): theme, primitives, and the
// Household-members / AI-settings / Models(Ollama) sections.
// Data comes from settings-data.js. App + matrix + dialog live in settings-app.jsx.

const SERIF = '"DM Serif Display", Georgia, serif';
const SANS = '"Geist", -apple-system, system-ui, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, monospace';

const TH = {
  bg: '#ece3d4', surface: '#fbf7f0', surfaceAlt: '#f4ede0', inset: '#f0e8da',
  ink: '#262320', inkSoft: 'rgba(38,35,32,0.62)', inkMute: 'rgba(38,35,32,0.42)',
  hint: 'rgba(38,35,32,0.34)',
  rule: 'rgba(38,35,32,0.10)', ruleHard: 'rgba(38,35,32,0.17)',
  accent: '#9c4a2f',                 // terracotta — primary actions
  accentSoft: 'rgba(156,74,47,0.10)',
  ok: '#3d6b4f', okSoft: 'rgba(61,107,79,0.12)',     // connected / allowed
  caution: '#b97a1e', cautionSoft: 'rgba(185,122,30,0.12)',
  cloud: '#2c5aa0', cloudSoft: 'rgba(44,90,160,0.10)',
};

const { useState: sS, useEffect: sE, useRef: sR, useMemo: sM } = React;

// ── icons (hairline) ─────────────────────────────────────────────────────────
const I = {
  check: (p) => <svg width={p?.s || 14} height={p?.s || 14} viewBox="0 0 16 16" fill="none"><path d="M3 8.4l3.2 3.2L13 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  plus: (p) => <svg width={p?.s || 14} height={p?.s || 14} viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>,
  x: (p) => <svg width={p?.s || 13} height={p?.s || 13} viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  refresh: (p) => <svg width={p?.s || 14} height={p?.s || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5V5h-2.5"/></svg>,
  trash: (p) => <svg width={p?.s || 14} height={p?.s || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.6 8h5.8l.6-8"/></svg>,
  edit: (p) => <svg width={p?.s || 14} height={p?.s || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M11.2 2.8l2 2L6 12l-2.6.6L4 10z"/></svg>,
  lock: (p) => <svg width={p?.s || 12} height={p?.s || 12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="3.5" y="7" width="9" height="6.5" rx="1.3"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" strokeLinecap="round"/></svg>,
  cpu: (p) => <svg width={p?.s || 14} height={p?.s || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"><rect x="4.5" y="4.5" width="7" height="7" rx="1"/><path d="M6.5 1.6v1.6M9.5 1.6v1.6M6.5 12.8v1.6M9.5 12.8v1.6M1.6 6.5h1.6M1.6 9.5h1.6M12.8 6.5h1.6M12.8 9.5h1.6" strokeLinecap="round"/></svg>,
  cloud: (p) => <svg width={p?.s || 14} height={p?.s || 14} viewBox="0 0 18 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"><path d="M5 12.5a3 3 0 0 1-.3-6 4 4 0 0 1 7.7-1A2.75 2.75 0 0 1 13 12.5z" strokeLinecap="round"/></svg>,
  cog: (p) => <svg width={p?.s || 18} height={p?.s || 18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/></svg>,
};

// ── primitives ────────────────────────────────────────────────────────────────
function Card({ children, style }) {
  return (
    <div style={{
      background: TH.surface, border: `0.5px solid ${TH.ruleHard}`, borderRadius: 16,
      boxShadow: '0 1px 2px rgba(38,35,32,0.03), 0 8px 30px rgba(38,35,32,0.05)', ...style,
    }}>{children}</div>
  );
}

function SectionHead({ kicker, title, desc, action }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
      <div>
        {kicker && <div style={{ fontFamily: MONO, fontSize: 10.5, color: TH.inkMute, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 7 }}>{kicker}</div>}
        <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: 27, color: TH.ink, letterSpacing: '-0.015em', fontWeight: 400, lineHeight: 1.05 }}>{title}</h2>
        {desc && <p style={{ margin: '7px 0 0', fontFamily: SANS, fontSize: 13.5, color: TH.inkSoft, maxWidth: 520, lineHeight: 1.5 }}>{desc}</p>}
      </div>
      {action}
    </div>
  );
}

function Btn({ children, onClick, kind = 'default', size = 'md', icon, disabled, title }) {
  const pad = size === 'sm' ? '5px 11px' : '8px 15px';
  const fs = size === 'sm' ? 12 : 13;
  const base = {
    all: 'unset', boxSizing: 'border-box', cursor: disabled ? 'default' : 'default',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
    fontFamily: SANS, fontSize: fs, fontWeight: 500, padding: pad, borderRadius: 999,
    whiteSpace: 'nowrap', opacity: disabled ? 0.4 : 1,
  };
  const kinds = {
    primary: { background: TH.ink, color: '#fbf7f0' },
    default: { background: TH.surface, color: TH.ink, boxShadow: `inset 0 0 0 0.5px ${TH.ruleHard}` },
    ghost: { background: 'transparent', color: TH.inkSoft, boxShadow: `inset 0 0 0 0.5px ${TH.rule}` },
    danger: { background: 'transparent', color: TH.accent, boxShadow: `inset 0 0 0 0.5px ${TH.accent}40` },
    accent: { background: TH.accent, color: '#fff' },
  };
  return (
    <button title={title} onClick={disabled ? undefined : onClick} style={{ ...base, ...kinds[kind] }}>
      {icon}{children}
    </button>
  );
}

function Field({ label, hint, children, suffix }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 6 }}>
        <span style={{ fontFamily: SANS, fontSize: 12.5, fontWeight: 500, color: TH.ink, whiteSpace: 'nowrap' }}>{label}</span>
        {suffix}
      </div>
      {children}
      {hint && <div style={{ fontFamily: MONO, fontSize: 10, color: TH.inkMute, marginTop: 5 }}>{hint}</div>}
    </label>
  );
}

function inputStyle(extra) {
  return {
    all: 'unset', boxSizing: 'border-box', display: 'block', width: '100%',
    fontFamily: SANS, fontSize: 14, color: TH.ink, padding: '10px 13px',
    background: TH.inset, borderRadius: 10, boxShadow: `inset 0 0 0 0.5px ${TH.ruleHard}`,
    ...extra,
  };
}
function Input({ mono, ...props }) {
  return <input {...props} style={inputStyle(mono ? { fontFamily: MONO, fontSize: 13 } : null)} />;
}

function Avatar({ m, size = 36 }) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
      <img src={m.avatar} alt={m.name} style={{ width: size, height: size, borderRadius: size / 2, objectFit: 'cover', display: 'block', boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.18)' }} />
    </span>
  );
}

function RoleTag({ role }) {
  const admin = role === 'admin';
  return (
    <span style={{
      fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase',
      padding: '3px 8px', borderRadius: 5, fontWeight: 500,
      color: admin ? TH.accent : TH.inkSoft, background: admin ? TH.accentSoft : TH.inset,
      boxShadow: `inset 0 0 0 0.5px ${admin ? TH.accent + '33' : TH.rule}`,
    }}>{role}</span>
  );
}

// tier tag for a model (cloud metered / on-device private)
function TierTag({ model, small }) {
  const local = model.tier === 'local';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontFamily: MONO, fontSize: small ? 8.5 : 9.5, letterSpacing: '0.04em', textTransform: 'uppercase',
      padding: small ? '2px 6px' : '3px 8px', borderRadius: 5, fontWeight: 500,
      color: local ? TH.ok : TH.cloud, background: local ? TH.okSoft : TH.cloudSoft,
    }}>
      <span style={{ display: 'flex' }}>{local ? <I.cpu s={small ? 10 : 12} /> : <I.cloud s={small ? 11 : 13} />}</span>
      {local ? 'on-device' : 'cloud'}
    </span>
  );
}

// ── 1 · Household members ─────────────────────────────────────────────────────
function MembersSection({ members, onEdit, onDelete, onAdd }) {
  return (
    <section>
      <SectionHead kicker="01 · People" title="Household members"
        desc="Everyone who can summon Maurice. Admins manage settings and who gets which models."
        action={<Btn kind="primary" icon={<I.plus />} onClick={onAdd}>Add member</Btn>} />
      <Card>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {members.map((m, i) => (
            <div key={m.id} style={{
              display: 'flex', alignItems: 'center', gap: 14, padding: '13px 18px', flexWrap: 'wrap',
              borderTop: i ? `0.5px solid ${TH.rule}` : 'none',
            }}>
              <Avatar m={m} size={38} />
              <div style={{ flex: '1 1 150px', minWidth: 0 }}>
                <div style={{ fontFamily: SANS, fontSize: 15, fontWeight: 600, color: TH.ink, lineHeight: 1.2 }}>{m.name}</div>
                <div style={{ fontFamily: MONO, fontSize: 11.5, color: TH.inkMute, marginTop: 1 }}>@{m.handle}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginLeft: 'auto' }}>
                <RoleTag role={m.role} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: m.pin ? TH.ok : TH.inkMute }}>
                  {m.pin && <span style={{ display: 'flex' }}><I.lock s={12} /></span>}
                  <span style={{ fontFamily: MONO, fontSize: 11, color: TH.inkSoft, whiteSpace: 'nowrap' }}>{m.pin ? 'PIN set' : 'no PIN'}</span>
                </div>
                <div style={{ display: 'flex', gap: 7 }}>
                  <Btn kind="default" size="sm" icon={<I.edit s={12} />} onClick={() => onEdit(m)}>Edit</Btn>
                  {m.role !== 'admin' && <Btn kind="danger" size="sm" icon={<I.trash s={12} />} onClick={() => onDelete(m)}>Remove</Btn>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </section>
  );
}

// ── 2 · AI settings ───────────────────────────────────────────────────────────
function AISection({ household, models, onChange, onSave }) {
  return (
    <section>
      <SectionHead kicker="02 · Engine" title="AI settings"
        desc="Keys, the household-wide default, and generation limits." />
      <Card style={{ padding: 22 }}>
        <div className="two-col" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <Field label="Household name">
              <Input value={household.name} onChange={(e) => onChange({ name: e.target.value })} />
            </Field>
          </div>
          <Field label="Anthropic API key" hint="Leave blank to keep the current key.">
            <Input type="password" placeholder={household.anthropicKeySet ? '•••••••• (saved)' : 'sk-ant-…'} mono onChange={() => {}} />
          </Field>
          <Field label="FAL API key" hint="Image generation. Blank keeps current.">
            <Input type="password" placeholder={household.falKeySet ? '•••••••• (saved)' : 'fal-…'} mono onChange={() => {}} />
          </Field>
          <Field label="Default model" hint="Used when a member hasn't picked one (must be in their allowed set).">
            <div style={{ position: 'relative' }}>
              <select value={household.defaultModel} onChange={(e) => onChange({ defaultModel: e.target.value })}
                style={{ ...inputStyle(), appearance: 'none', cursor: 'default', paddingRight: 34 }}>
                {models.map((m) => <option key={m.id} value={m.id}>{m.name}{m.tier === 'local' ? '  · on-device' : ''}</option>)}
              </select>
              <span style={{ position: 'absolute', right: 13, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: TH.inkMute }}>
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </span>
            </div>
          </Field>
          <Field label="Max tokens" hint="Per-response output ceiling.">
            <Input type="number" value={household.maxTokens} mono onChange={(e) => onChange({ maxTokens: +e.target.value })} />
          </Field>
        </div>
        <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end' }}>
          <Btn kind="primary" onClick={onSave}>Save settings</Btn>
        </div>
      </Card>
    </section>
  );
}

Object.assign(window, {
  SERIF, SANS, MONO, TH, I, sS, sE, sR, sM,
  Card, SectionHead, Btn, Field, Input, inputStyle, Avatar, RoleTag, TierTag,
  MembersSection, AISection,
});
