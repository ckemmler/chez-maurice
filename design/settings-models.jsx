// settings-models.jsx — the Models section: an Ollama discovery card (auto
// /api/tags + manual add) and an Anthropic cloud card. Reuses settings-core.

function RamBar({ used, total, label }) {
  const pct = Math.min(100, (used / total) * 100);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
      {label && <span style={{ fontFamily: MONO, fontSize: 9.5, color: TH.inkMute, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{label}</span>}
      <span style={{ width: 54, height: 4, borderRadius: 2, background: TH.inset, boxShadow: `inset 0 0 0 0.5px ${TH.rule}`, overflow: 'hidden' }}>
        <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: TH.ok }} />
      </span>
      <span style={{ fontFamily: MONO, fontSize: 10.5, color: TH.inkSoft }}>{used} / {total} GB</span>
    </span>
  );
}

// one model row inside a card
function ModelRow({ model, count, total, onRemove, first }) {
  const local = model.tier === 'local';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '12px 16px', borderTop: first ? 'none' : `0.5px solid ${TH.rule}` }}>
      <span style={{
        width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: local ? TH.ok : TH.cloud, background: local ? TH.okSoft : TH.cloudSoft,
      }}>{local ? <I.cpu s={15} /> : <I.cloud s={15} />}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
          <span style={{ fontFamily: SANS, fontSize: 14, fontWeight: 600, color: TH.ink, whiteSpace: 'nowrap' }}>{model.name}</span>
          <span style={{ fontFamily: MONO, fontSize: 11, color: TH.inkMute, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model.id}</span>
        </div>
        <div style={{ fontFamily: SANS, fontSize: 12, color: TH.inkSoft, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model.desc}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 }}>
        <span style={{ fontFamily: MONO, fontSize: 10.5, color: TH.inkMute, width: 58, textAlign: 'right' }}>{model.ctx}k ctx</span>
        {local && <span style={{ width: 72, textAlign: 'right' }}><span style={{ fontFamily: MONO, fontSize: 10.5, color: TH.inkSoft }}>{model.ram} GB</span></span>}
        <span style={{
          fontFamily: MONO, fontSize: 10.5, color: count ? TH.ink : TH.inkMute, width: 92, textAlign: 'right',
        }}>{count}/{total} can use</span>
        {onRemove
          ? <button title="Remove model" onClick={() => onRemove(model)} style={{ all: 'unset', cursor: 'default', color: TH.inkMute, display: 'flex', padding: 4 }}><I.trash s={13} /></button>
          : <span style={{ width: 21 }} />}
      </div>
    </div>
  );
}

function AddModelForm({ onAdd, onCancel }) {
  const [id, setId] = sS('');
  const [name, setName] = sS('');
  const [ram, setRam] = sS('');
  const ok = id.trim() && name.trim();
  return (
    <div style={{ padding: 16, borderTop: `0.5px solid ${TH.rule}`, background: TH.surfaceAlt }}>
      <div style={{ fontFamily: MONO, fontSize: 10, color: TH.inkMute, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 12 }}>
        Add a model Ollama didn’t report
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 0.7fr', gap: 12, alignItems: 'end' }}>
        <Field label="Ollama tag"><Input value={id} placeholder="e.g. phi4:14b" mono onChange={(e) => setId(e.target.value)} /></Field>
        <Field label="Display name"><Input value={name} placeholder="Phi-4 14B" onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="RAM (GB)"><Input value={ram} placeholder="9" mono onChange={(e) => setRam(e.target.value)} /></Field>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, marginTop: 14 }}>
        <Btn kind="ghost" size="sm" onClick={onCancel}>Cancel</Btn>
        <Btn kind="accent" size="sm" disabled={!ok} icon={<I.plus s={13} />}
          onClick={() => ok && onAdd({ id: id.trim(), name: name.trim(), tier: 'local', vendor: 'Ollama', ram: +ram || 0, ctx: 8, discovered: false, desc: 'Added manually.' })}>
          Add model
        </Btn>
      </div>
    </div>
  );
}

function ModelsSection({ models, ollama, accessCount, memberCount, onRescan, onAddModel, onRemoveModel, onToggleOllama }) {
  const [adding, setAdding] = sS(false);
  const [scanning, setScanning] = sS(false);
  const cloud = models.filter((m) => m.tier === 'cloud');
  const local = models.filter((m) => m.tier === 'local');
  const usedRam = local.reduce((a, m) => a + (m.ram || 0), 0);
  const maxRam = local.length ? Math.max(...local.map((m) => m.ram || 0)) : 0;

  const rescan = () => { setScanning(true); setTimeout(() => { setScanning(false); onRescan(); }, 750); };

  return (
    <section>
      <SectionHead kicker="03 · Models" title="Models"
        desc="Anthropic runs in the cloud (metered). Ollama runs on your Mac mini — private, no usage cost, discovered automatically." />

      {/* Ollama card */}
      <Card style={{ overflow: 'hidden', marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '15px 18px', background: ollama.connected ? TH.okSoft : TH.cautionSoft }}>
          <span style={{ width: 38, height: 38, borderRadius: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: TH.surface, color: ollama.connected ? TH.ok : TH.caution, boxShadow: `inset 0 0 0 0.5px ${TH.ruleHard}` }}>
            <I.cpu s={19} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: SANS, fontSize: 15, fontWeight: 600, color: TH.ink }}>Ollama</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: MONO, fontSize: 10.5, color: ollama.connected ? TH.ok : TH.caution }}>
                <span style={{ width: 7, height: 7, borderRadius: 4, background: ollama.connected ? TH.ok : TH.caution }} />
                {ollama.connected ? 'Connected' : 'Not reachable'}
              </span>
            </div>
            <div style={{ fontFamily: MONO, fontSize: 11, color: TH.inkSoft, marginTop: 3 }}>
              {ollama.connected ? `${ollama.host} · v${ollama.version} · ${local.length} models · scanned ${ollama.lastScan}` : `Tried ${ollama.host}`}
            </div>
          </div>
          {ollama.connected && <RamBar used={maxRam} total={ollama.totalRamGB} label="largest fits" />}
          <Btn kind="default" size="sm" icon={<span style={{ display: 'flex', animation: scanning ? 'spin 0.75s linear infinite' : 'none' }}><I.refresh s={13} /></span>} onClick={rescan}>
            {scanning ? 'Scanning…' : 'Rescan'}
          </Btn>
        </div>

        {ollama.connected ? (
          <div>
            {local.map((m, i) => (
              <ModelRow key={m.id} model={m} first={i === 0} count={accessCount[m.id] || 0} total={memberCount}
                onRemove={m.discovered ? null : onRemoveModel} />
            ))}
            {adding
              ? <AddModelForm onAdd={(mdl) => { onAddModel(mdl); setAdding(false); }} onCancel={() => setAdding(false)} />
              : <div style={{ padding: '12px 16px', borderTop: `0.5px solid ${TH.rule}` }}>
                  <Btn kind="ghost" size="sm" icon={<I.plus s={13} />} onClick={() => setAdding(true)}>Add a model manually</Btn>
                </div>}
          </div>
        ) : (
          <div style={{ padding: 18 }}>
            <p style={{ margin: '0 0 12px', fontFamily: SANS, fontSize: 13, color: TH.inkSoft, lineHeight: 1.55 }}>
              Start Ollama on the Mac mini and make sure it’s listening on the host above. Models install with <span style={{ fontFamily: MONO, fontSize: 12 }}>ollama pull</span>; they’ll appear here on the next scan.
            </p>
            <Btn kind="default" size="sm" icon={<I.refresh s={13} />} onClick={rescan}>Try again</Btn>
          </div>
        )}
      </Card>

      {/* Cloud card */}
      <Card style={{ overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '15px 18px', background: TH.cloudSoft }}>
          <span style={{ width: 38, height: 38, borderRadius: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: TH.surface, color: TH.cloud, boxShadow: `inset 0 0 0 0.5px ${TH.ruleHard}` }}>
            <I.cloud s={19} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: SANS, fontSize: 15, fontWeight: 600, color: TH.ink }}>Anthropic</div>
            <div style={{ fontFamily: MONO, fontSize: 11, color: TH.inkSoft, marginTop: 3 }}>api.anthropic.com · key set · metered usage</div>
          </div>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: MONO, fontSize: 10.5, color: TH.cloud }}>
            <span style={{ width: 7, height: 7, borderRadius: 4, background: TH.cloud }} />Connected
          </span>
        </div>
        {cloud.map((m, i) => (
          <ModelRow key={m.id} model={m} first={i === 0} count={accessCount[m.id] || 0} total={memberCount} onRemove={null} />
        ))}
      </Card>
    </section>
  );
}

Object.assign(window, { ModelsSection, ModelRow, AddModelForm, RamBar });
