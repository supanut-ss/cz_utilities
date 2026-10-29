import React, { useEffect, useMemo, useRef, useState } from 'react';
import packageInfo from '../package.json';
import { Layers, Blocks, Bot, FolderOpen, Search, Plus, Upload, Download, Pencil, Trash2, Check, X, ArrowUpRight, FileText, ChevronRight, AlertCircle, LoaderCircle, Monitor, Package, Settings2 } from 'lucide-react';
import { api, isBrowserPreview } from './browser-adapter.js';
import { RepositoryImport, InstallToAI } from './NativeWorkflows.jsx';
import TransferMachine from './TransferMachine.jsx';
import { RepositoryLink, RepositoryOrigin } from './RepositoryOrigin.jsx';

const equalIds = (a, b) => a.length === b.length && [...a].sort().every((id, index) => id === [...b].sort()[index]);
const emptySkill = { name: '', description: '', category: 'ทั่วไป', content: '# Skill\n\n## Instructions\n\n' };

function Modal({ title, children, onClose, busy, error, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} aria-labelledby="modal-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="modal-header"><h2 id="modal-title">{title}</h2><button className="icon-button" aria-label="ปิดหน้าต่าง" onClick={onClose} disabled={busy}><X size={19} /></button></header>
    {error && <div className="modal-error" role="alert"><AlertCircle size={17} /><span>{error}</span></div>}
    {children}
  </dialog>;
}

function SkillEditor({ skill, onClose, onSave, busy, error }) {
  const [form, setForm] = useState(skill || emptySkill);
  const closeEditor = () => {
    if (JSON.stringify(form) !== JSON.stringify(skill || emptySkill) && !window.confirm('มีเนื้อหา Skill ที่ยังไม่บันทึก ต้องการละทิ้งการเปลี่ยนแปลงหรือไม่?')) return;
    onClose();
  };
  const field = (key) => ({ value: form[key], onChange: (event) => setForm({ ...form, [key]: event.target.value }) });
  return <Modal title={skill ? 'แก้ไข Skill' : 'สร้าง Skill ใหม่'} onClose={closeEditor} busy={busy} error={error} wide>
    <form onSubmit={(event) => { event.preventDefault(); onSave(form); }}>
      <div className="modal-content skill-form">
        <div className="form-columns"><label>ชื่อ Skill<input required maxLength={120} autoFocus {...field('name')} placeholder="เช่น Code Reviewer" /></label><label>หมวดหมู่<input required maxLength={60} {...field('category')} placeholder="เช่น พัฒนา" /></label></div>
        <label>คำอธิบาย<input maxLength={500} {...field('description')} placeholder="Skill นี้ช่วยทำอะไร" /></label>
        <label>คำสั่งใน SKILL.md<textarea aria-label="คำสั่งใน SKILL.md" required spellCheck="false" rows={14} maxLength={500000} {...field('content')} /></label>
        <p className="help-text">เขียนคำสั่งเป็น Markdown แอปจะเก็บเป็นไฟล์ SKILL.md โดยไม่รันคำสั่งในไฟล์</p>
      </div>
      <footer className="modal-footer"><button type="button" className="button" onClick={closeEditor} disabled={busy}>ยกเลิก</button><button type="submit" className="button primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}บันทึก Skill</button></footer>
    </form>
  </Modal>;
}

function ProfileEditor({ profile, onClose, onSave, busy, error }) {
  const [form, setForm] = useState(profile || { name: '', provider: 'Codex', skillIds: [] });
  return <Modal title={profile ? 'แก้ไขโปรไฟล์ AI' : 'เพิ่มโปรไฟล์ AI'} onClose={onClose} busy={busy} error={error}>
    <form onSubmit={(event) => { event.preventDefault(); onSave(form); }}><div className="modal-content">
      <label>ชื่อโปรไฟล์<input autoFocus required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="เช่น Codex สำหรับงานเว็บไซต์" /></label>
      <label>ระบบ AI<select value={['Codex', 'Claude', 'Gemini', 'ChatGPT', 'Cursor', 'อื่น ๆ'].includes(form.provider) ? form.provider : 'อื่น ๆ'} onChange={(e) => setForm({ ...form, provider: e.target.value })}>{['Codex', 'Claude', 'Gemini', 'ChatGPT', 'Cursor', 'อื่น ๆ'].map((provider) => <option key={provider}>{provider}</option>)}</select></label>
      <p className="help-text">โปรไฟล์คือชุด Skill ที่เตรียมไว้สำหรับ AI ชื่อเดียวกันสร้างได้หลายโปรไฟล์ตามประเภทงาน</p>
    </div><footer className="modal-footer"><button type="button" className="button" onClick={onClose} disabled={busy}>ยกเลิก</button><button className="button primary" disabled={busy}>บันทึกโปรไฟล์</button></footer></form>
  </Modal>;
}

export default function App() {
  const [state, setState] = useState(null);
  const [page, setPage] = useState('library');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('ทั้งหมด');
  const [skillKind, setSkillKind] = useState('all');
  const [profileId, setProfileId] = useState('');
  const [draft, setDraft] = useState([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [modal, setModal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [discovery, setDiscovery] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [foundSelection, setFoundSelection] = useState([]);
  const [foundSearch, setFoundSearch] = useState('');
  const [pendingSidecar, setPendingSidecar] = useState(null);
  const pendingRequested = useRef(false);
  const restorationEpoch = useRef(0);
  const loadGeneration = useRef(0);
  const profile = state?.profiles.find((item) => item.id === profileId);
  const dirty = !!profile && !equalIds(draft, profile.skillIds);
  const activeProfileRef = useRef(profileId);
  activeProfileRef.current = profileId;

  async function loadState() {
    const generation = ++loadGeneration.current;
    setLoading(true);
    try {
      const next = await api.getState();
      if (generation !== loadGeneration.current) return;
      setState(next);
      const first = next.profiles[0];
      setProfileId(first?.id || '');
      setDraft(first?.skillIds || []);
      setNotice(null);
    } catch (error) { if (generation === loadGeneration.current) setNotice({ error: true, message: error.message || 'โหลดข้อมูลไม่สำเร็จ' }); }
    finally { if (generation === loadGeneration.current) setLoading(false); }
  }

  useEffect(() => { loadState(); }, []);
  useEffect(() => {
    if (isBrowserPreview || loading || !state || pendingRequested.current) return;
    pendingRequested.current = true;
    const epoch = restorationEpoch.current;
    api.pendingMigration().then(preview => {
      if (preview && restorationEpoch.current === epoch) setPendingSidecar(preview);
    }).catch(error => {
      if (restorationEpoch.current === epoch) setNotice({ error: true, message: error.message || 'ตรวจชุดย้ายเครื่องข้างตัวแอปไม่สำเร็จ' });
    });
  }, [loading, state]);
  useEffect(() => {
    if (pendingSidecar && !modal && !busy && !loading) {
      setModal({ type: 'migration', preview: pendingSidecar });
      setPendingSidecar(null);
    }
  }, [pendingSidecar, modal, busy, loading]);
  useEffect(() => { if (!isBrowserPreview) refreshDiscovery(); }, []);
  useEffect(() => {
    const warn = (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function action(task, success, options = {}) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await task();
      if (result === null) return;
      if (result?.version === 1) {
        setState(result);
        const current = result.profiles.find((item) => item.id === activeProfileRef.current) || result.profiles[0];
        setProfileId(current?.id || '');
        if (options.resetDraft || !current || current.id !== activeProfileRef.current) setDraft(current?.skillIds || []);
        else setDraft((ids) => ids.filter((id) => result.skills.some((skill) => skill.id === id)));
      }
      if (options.closeModal) setModal(null);
      if (success) setNotice({ error: false, message: typeof success === 'function' ? success(result) : success });
      return result;
    } catch (error) {
      setNotice({ error: true, message: error.message || 'ทำรายการไม่สำเร็จ กรุณาลองอีกครั้ง' });
    } finally { setBusy(false); }
  }

  function switchProfile(id) {
    if (id === profileId) return true;
    if (dirty && !window.confirm('มีการเลือก Skill ที่ยังไม่บันทึก ต้องการละทิ้งการเปลี่ยนแปลงและสลับโปรไฟล์หรือไม่?')) return false;
    setProfileId(id);
    setDraft(state.profiles.find((item) => item.id === id)?.skillIds || []);
    return true;
  }

  function toggleSkill(id) {
    setDraft((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);
  }

  async function refreshDiscovery() {
    setScanning(true);
    setScanError('');
    try {
      const result = await api.discoverSkills();
      setDiscovery(result);
      setFoundSelection([]);
    } catch (error) { setScanError(error.message || 'ค้นหา Skill ไม่สำเร็จ กรุณาลองอีกครั้ง'); }
    finally { setScanning(false); }
  }

  async function importFound() {
    const result = await action(() => api.importDiscovered(foundSelection));
    if (!result) return;
    setState(result.state);
    const failures = result.failures || [];
    const message = `นำเข้าแล้ว ${result.importedCount} Skill` + (failures.length ? ` · นำเข้าไม่สำเร็จ ${failures.length} รายการ: ${failures.map(item => `${item.name}: ${item.error}`).join('; ')}` : '');
    setNotice({ error: failures.length > 0, message });
    if (!failures.length) setModal(null);
    await refreshDiscovery();
  }

  function exportProfile(id) {
    action(() => api.exportProfile(id), (result) => `ส่งออก ${result.count} Skill แล้ว: ${result.path}`);
  }

  function restoredLibrary(next) {
    restorationEpoch.current += 1;
    loadGeneration.current += 1;
    setPendingSidecar(null);
    const selected = next.profiles.find(item => item.id === activeProfileRef.current) || next.profiles[0];
    setState(next);
    setProfileId(selected?.id || '');
    setDraft(selected?.skillIds || []);
    setLoading(false);
    setNotice(null);
    if (!isBrowserPreview) refreshDiscovery();
  }

  function beforeRestore() {
    return !dirty || window.confirm('การนำเข้าจะรวมกับคลังเดิม และโหลดชุดที่บันทึกไว้แทนการเลือก Skill ที่ยังไม่บันทึก ต้องการละทิ้งการเลือกที่ยังไม่บันทึกและดำเนินการหรือไม่?');
  }

  const categories = useMemo(() => ['ทั้งหมด', ...new Set((state?.skills || []).map((skill) => skill.category || 'ทั่วไป'))], [state]);
  const effectiveCategory = categories.includes(category) ? category : 'ทั้งหมด';
  const skillKindCounts = useMemo(() => (state?.skills || []).reduce((counts, skill) => {
    counts.all += 1;
    if (skill.source === 'created') counts.custom += 1;
    if (skill.source === 'imported') counts.premade += 1;
    return counts;
  }, { all: 0, custom: 0, premade: 0 }), [state]);
  const visibleSkills = useMemo(() => (state?.skills || []).filter((skill) => (skillKind === 'all' || (skillKind === 'custom' && skill.source === 'created') || (skillKind === 'premade' && skill.source === 'imported')) && (effectiveCategory === 'ทั้งหมด' || (skill.category || 'ทั่วไป') === effectiveCategory) && `${skill.name} ${skill.description} ${skill.category}`.toLowerCase().includes(search.toLowerCase())), [state, effectiveCategory, search, skillKind]);

  const saveAssignments = () => action(() => api.saveProfile({ ...profile, skillIds: draft }), 'บันทึกชุด Skill แล้ว', { resetDraft: true });
  const selectedSkills = (state?.skills || []).filter((skill) => draft.includes(skill.id));

  return <div className="app-shell" aria-busy={busy || loading}>
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><Layers size={21} /></span><div>Skill Hub<small>พื้นที่จัดการ AI ของคุณ</small></div></div>
      <nav aria-label="เมนูหลัก"><button className={`nav-item ${page === 'library' ? 'active' : ''}`} aria-current={page === 'library' ? 'page' : undefined} onClick={() => setPage('library')}><Blocks size={19} />คลัง Skill<span>{state?.skills.length || 0}</span></button><button className={`nav-item ${page === 'profiles' ? 'active' : ''}`} aria-current={page === 'profiles' ? 'page' : undefined} onClick={() => setPage('profiles')}><Bot size={19} />AI ของฉัน<span>{state?.profiles.length || 0}</span></button></nav>
      <button className="nav-item sidebar-transfer" disabled={busy || loading} onClick={() => { setNotice(null); setModal({ type: 'migration' }); }}><Package size={18} />ย้ายเครื่อง</button>
      <div className="sidebar-bottom"><div className="local-label"><Monitor size={16} /><span>{isBrowserPreview ? 'โหมดตัวอย่างเบราว์เซอร์' : 'บันทึกบนเครื่อง Windows'}</span></div><button className="text-button" disabled={busy || isBrowserPreview} onClick={() => action(() => api.openDataFolder())}><FolderOpen size={16} />เปิดโฟลเดอร์ข้อมูล</button><span className="sidebar-caption">{isBrowserPreview ? 'ข้อมูลแยกจากแอปเดสก์ท็อป' : 'ไม่ต้องใช้บัญชีหรือ API key'}</span></div>
    </aside>
    <main className="main">
      <header className="app-header"><span>พื้นที่ส่วนตัว <ChevronRight size={14} />{page === 'library' ? 'คลัง Skill' : 'AI ของฉัน'}</span><span className="app-version">Skill Hub · Windows · v{packageInfo.version}</span></header>
      <div className="workspace">
        {!isBrowserPreview && page === 'library' && <div className="discovery-banner" role="status"><Monitor size={19} /><div><strong>{scanning ? 'กำลังค้นหา Skill บนเครื่อง…' : scanError ? 'ค้นหา Skill บนเครื่องไม่สำเร็จ' : discovery ? `พบ ${discovery.items.length} Skill บนเครื่อง` : 'ค้นหา Skill ที่ติดตั้งไว้'}</strong><p>{scanError || 'อ่านจากโฟลเดอร์ Skill ของ AI ที่รู้จัก โดยไม่แก้ไขไฟล์ต้นฉบับ'}</p></div><button className="button" disabled={busy || scanning} onClick={() => { setModal({ type: 'discovery' }); if (!discovery || scanError) refreshDiscovery(); }}><Search size={16} />ดู Skill บนเครื่อง</button></div>}
        {isBrowserPreview && <div className="preview-banner"><Monitor size={17} /><span>กำลังแสดงตัวอย่างในเบราว์เซอร์ ข้อมูลเก็บเฉพาะเบราว์เซอร์นี้ การนำเข้าคลังโค้ด นำเข้าและส่งออกโฟลเดอร์ และติดตั้งให้ AI ใช้ในแอป Windows</span></div>}
        {notice && <div className={`notice ${notice.error ? 'notice-error' : 'notice-success'}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <AlertCircle size={18} /> : <Check size={18} />}<span>{notice.message}</span><button className="icon-button" aria-label="ปิดข้อความ" onClick={() => setNotice(null)}><X size={16} /></button></div>}
        {loading ? <div className="loading-state"><LoaderCircle className="spin" size={25} />กำลังเปิดคลัง Skill…</div> : !state ? <div className="empty-state"><AlertCircle size={32} /><h1>เปิดคลัง Skill ไม่สำเร็จ</h1><p>ตรวจข้อความด้านบนแล้วลองเปิดคลังอีกครั้ง</p><button className="button primary" onClick={loadState}>ลองอีกครั้ง</button></div> : <>
          <div className="page-heading"><div><h1>{page === 'library' ? 'คลัง Skill' : 'AI ของฉัน'}</h1><p>{page === 'library' ? 'เก็บความสามารถไว้ที่เดียว แล้วเลือกให้เหมาะกับผู้ช่วยแต่ละตัว' : 'จัดชุดความสามารถแยกตาม AI และลักษณะงานของคุณ'}</p></div><div className="heading-actions">{page === 'library' ? <button className="button primary" disabled={busy} onClick={() => setModal({ type: 'add-skill' })}><Plus size={17} />เพิ่ม Skill</button> : <button className="button primary" disabled={busy} onClick={() => setModal({ type: 'profile' })}><Plus size={17} />เพิ่มโปรไฟล์ AI</button>}</div></div>
          {page === 'library' ? <div className="library-layout"><section className="library" aria-label="รายการ Skill">
            <div className="library-toolbar"><label className="search-field"><Search size={18} /><input aria-label="ค้นหา Skill" type="search" placeholder="ค้นหาชื่อหรือความสามารถ…" value={search} onChange={(event) => setSearch(event.target.value)} /></label><label className="category-select"><span className="sr-only">หมวดหมู่</span><select value={effectiveCategory} onChange={(event) => setCategory(event.target.value)}>{categories.map((item) => <option key={item}>{item}</option>)}</select></label></div>
            <div className="skill-kind-filter" role="group" aria-label="ประเภท Skill">
              <button type="button" aria-pressed={skillKind === 'all'} onClick={() => setSkillKind('all')}>ทั้งหมด<span className="skill-kind-count">{skillKindCounts.all}</span></button>
              <button type="button" aria-pressed={skillKind === 'custom'} onClick={() => setSkillKind('custom')}>Custom<span className="skill-kind-count">{skillKindCounts.custom}</span></button>
              <button type="button" aria-pressed={skillKind === 'premade'} onClick={() => setSkillKind('premade')}>สำเร็จรูป<span className="skill-kind-count">{skillKindCounts.premade}</span></button>
            </div>
            <div className="list-caption"><span>{visibleSkills.length} Skill{effectiveCategory !== 'ทั้งหมด' ? ` ในหมวด${effectiveCategory}` : ' ในคลัง'}</span><span>{profile ? `เลือกให้ ${profile.name}` : 'เพิ่มโปรไฟล์เพื่อเลือก Skill'}</span></div>
            {!state.skills.length ? <div className="empty-library"><div className="empty-symbol"><Blocks size={34} strokeWidth={1.5} /></div><h2>เริ่มคลัง Skill ของคุณ</h2><p>นำเข้าโฟลเดอร์ที่มี SKILL.md หรือสร้างคำสั่งใหม่<br />แล้วเลือกว่าจะให้ AI ตัวไหนใช้ความสามารถนี้</p><div className="empty-actions"><button className="button primary" disabled={busy} onClick={() => setModal({ type: 'add-skill' })}><Plus size={16} />เพิ่ม Skill แรก</button></div></div> : !visibleSkills.length ? <div className="empty-library compact"><Search size={28} /><h2>{search || effectiveCategory !== 'ทั้งหมด' ? 'ไม่พบ Skill ที่ตรงกับตัวกรอง' : skillKind === 'custom' ? 'ยังไม่มี Custom Skill' : skillKind === 'premade' ? 'ยังไม่มี Skill สำเร็จรูป' : 'ไม่พบ Skill'}</h2><p>{search || effectiveCategory !== 'ทั้งหมด' ? 'ลองเปลี่ยนคำค้นหรือเลือกหมวดหมู่อื่น' : skillKind === 'custom' ? 'สร้าง Skill ในแอปเพื่อเก็บคำสั่งที่คุณปรับเอง' : skillKind === 'premade' ? 'เพิ่มจาก repository หรือโฟลเดอร์ผ่านปุ่มเพิ่ม Skill' : 'ลองเปลี่ยนคำค้นหรือเลือกหมวดหมู่อื่น'}</p><button className="text-button" onClick={() => { setSearch(''); setCategory('ทั้งหมด'); setSkillKind('all'); }}>แสดง Skill ทั้งหมด</button></div> : <div className="skill-list">{visibleSkills.map((skill) => <article className={`skill-row ${draft.includes(skill.id) ? 'is-selected' : ''}`} key={skill.id}>
              <label className="skill-select"><input type="checkbox" aria-label={`เลือก ${skill.name} ให้ ${profile?.name || 'AI'}`} checked={draft.includes(skill.id)} disabled={!profile || busy} onChange={() => toggleSkill(skill.id)} /><span className="skill-symbol"><FileText size={21} /></span></label><div className="skill-info"><button className="skill-name" onClick={() => setModal({ type: 'preview', skill })}>{skill.name}</button><p>{skill.description || 'ยังไม่มีคำอธิบาย'}</p><div className="skill-meta"><span className="category-tag">{skill.category || 'ทั่วไป'}</span><span className={`skill-kind-tag ${skill.source === 'created' ? 'is-custom' : 'is-premade'}`} title={skill.source === 'created' ? 'สร้างใน Skill Hub' : 'นำเข้าจาก repository หรือโฟลเดอร์'}>{skill.source === 'created' ? 'Custom' : 'สำเร็จรูป'}</span><RepositoryLink originRepo={skill.originRepo} skillName={skill.name} /><span>{skill.fileCount || 1} ไฟล์</span></div></div><div className="row-actions"><button className="icon-button" aria-label={`แก้ไข ${skill.name}`} disabled={busy} onClick={() => setModal({ type: 'skill', skill })}><Pencil size={16} /></button><button className="icon-button danger-quiet" aria-label={`ลบ ${skill.name}`} disabled={busy} onClick={() => { if (window.confirm(`ลบ “${skill.name}” ออกจากคลังและทุกโปรไฟล์หรือไม่?`)) action(() => api.deleteSkill(skill.id), 'ลบ Skill แล้ว'); }}><Trash2 size={16} /></button></div>
            </article>)}</div>}
            <div className="library-footer"><FileText size={15} /><span>Skill คือคำสั่งและไฟล์ประกอบ แอปเก็บเนื้อหาไว้โดยไม่เรียกใช้</span></div>
          </section><aside className="assignment-panel" aria-label="จัดชุด Skill"><header><div className="panel-title"><Settings2 size={18} /><h2>จัดชุดให้ AI</h2></div><p>เลือก AI → เลือก Skill → บันทึกและติดตั้ง</p></header><div className="assignment-body">
            {state.profiles.length ? <><label>1. เลือก AI<select disabled={busy} value={profileId} onChange={(event) => switchProfile(event.target.value)}>{state.profiles.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><div className="profile-summary"><span className="profile-avatar"><Bot size={22} /></span><div><strong>{profile?.name}</strong><small>{profile?.provider} · โปรไฟล์บนเครื่อง</small></div></div><div className="selection-heading"><span>2. Skill ในชุด</span><strong>{draft.length}</strong></div><div className="selected-skills">{selectedSkills.length ? selectedSkills.map((skill) => <div key={skill.id}><Check size={14} /><span>{skill.name}</span><button className="icon-button" disabled={busy} aria-label={`เอา ${skill.name} ออกจากชุด`} onClick={() => toggleSkill(skill.id)}><X size={14} /></button></div>) : <p className="selection-empty">เลือกช่องข้าง Skill เพื่อเพิ่มลงในชุดนี้</p>}</div><button className="button primary full-width" disabled={busy || !dirty} onClick={saveAssignments}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}3. บันทึกชุด Skill</button><div className={`draft-status ${dirty ? 'has-changes' : ''}`} role="status">{dirty ? 'มีการเปลี่ยนแปลงที่ยังไม่บันทึก' : 'ชุด Skill ตรงกับที่บันทึกไว้'}</div><button className="button full-width export-button" disabled={busy || dirty || !draft.length || isBrowserPreview} onClick={() => exportProfile(profileId)}><Download size={16} />ส่งออกชุด Skill</button><p className="help-text export-note">ส่งออกเป็นโฟลเดอร์ใหม่พร้อมไฟล์ประกอบ เพื่อให้คุณนำไปติดตั้งตามระบบ AI ที่ใช้</p></> : <div className="panel-empty"><Bot size={28} /><p>เพิ่มโปรไฟล์ AI ก่อนเริ่มจัดชุด Skill</p><button className="button primary" disabled={busy} onClick={() => setModal({ type: 'profile' })}>เพิ่มโปรไฟล์ AI</button></div>}
          {profile && <div className="native-install-action"><button className="button primary full-width" disabled={busy || dirty || !profile.skillIds.length || isBrowserPreview} onClick={() => { setNotice(null); setModal({ type: 'install', profile }); }}><Download size={16} />ตรวจสอบและติดตั้ง Skill</button><p className="help-text" role="status">{isBrowserPreview ? 'ติดตั้งชุด Skill ได้จากแอป Windows' : dirty ? 'บันทึกชุด Skill ก่อน แล้วจึงติดตั้งได้' : !profile.skillIds.length ? 'เลือกอย่างน้อย 1 Skill และบันทึกชุดก่อนติดตั้ง' : 'ตรวจสอบรายการติดตั้งก่อนยืนยันเขียนไฟล์ลงเครื่อง'}</p></div>}
          </div></aside></div> : <section className="profiles-grid" aria-label="โปรไฟล์ AI">{state.profiles.map((item) => <article className="profile-card" key={item.id}><div className="profile-card-heading"><span className="profile-avatar"><Bot size={24} /></span><div><h2>{item.name}</h2><p>{item.provider}</p></div><div className="row-actions"><button className="icon-button" aria-label={`แก้ไขโปรไฟล์ ${item.name}`} disabled={busy} onClick={() => setModal({ type: 'profile', profile: item })}><Pencil size={16} /></button><button className="icon-button danger-quiet" aria-label={`ลบโปรไฟล์ ${item.name}`} disabled={busy} onClick={() => { if (dirty && item.id === profileId && !window.confirm('โปรไฟล์นี้มีการเปลี่ยนแปลงที่ยังไม่บันทึก ต้องการละทิ้งหรือไม่?')) return; if (window.confirm(`ลบโปรไฟล์ “${item.name}” หรือไม่? Skill ในคลังยังคงอยู่`)) action(() => api.deleteProfile(item.id), 'ลบโปรไฟล์แล้ว', { resetDraft: item.id === profileId }); }}><Trash2 size={16} /></button></div></div><div className="profile-skill-count"><Package size={16} />{item.skillIds.length} Skill ที่บันทึกไว้</div><div className="profile-chips">{item.skillIds.length ? item.skillIds.map((id) => <span key={id}>{state.skills.find((skill) => skill.id === id)?.name || id}</span>) : <p>ยังไม่มี Skill เริ่มเลือกจากคลังได้เลย</p>}</div><footer><button className="button" disabled={busy} onClick={() => { if (switchProfile(item.id)) setPage('library'); }}>จัดการ Skill<ArrowUpRight size={16} /></button><button className="icon-button" disabled={busy || isBrowserPreview || !item.skillIds.length || (item.id === profileId && dirty)} aria-label={`ส่งออกชุด ${item.name}`} onClick={() => exportProfile(item.id)}><Download size={17} /></button></footer></article>)}<button className="add-profile-card" disabled={busy} onClick={() => setModal({ type: 'profile' })}><Plus size={25} /><strong>เพิ่มโปรไฟล์ AI</strong><span>แยกชุด Skill ตามงานที่ทำ</span></button></section>}
        </>}
      </div>
    </main>
    {modal?.type === 'add-skill' && <Modal title="เพิ่ม Skill" onClose={() => setModal(null)} busy={busy}><div className="modal-content add-skill-options"><p className="help-text">เลือกวิธีเพิ่ม Skill เข้าคลัง</p><button type="button" className="add-skill-option" disabled={busy} onClick={() => setModal({ type: 'skill' })}><span className="add-skill-option-icon"><FileText size={18} /></span><span className="add-skill-option-copy"><strong>สร้าง Skill ใหม่</strong><small>เขียนคำสั่งและบันทึกเป็น SKILL.md</small></span><ChevronRight size={17} /></button><button type="button" className="add-skill-option" disabled={busy || isBrowserPreview} onClick={() => { setNotice(null); setModal({ type: 'repository' }); }}><span className="add-skill-option-icon"><Upload size={18} /></span><span className="add-skill-option-copy"><strong>นำเข้าจาก Git repository</strong><small>นำ Skill พร้อมไฟล์ประกอบจากคลังโค้ด</small></span><ChevronRight size={17} /></button><button type="button" className="add-skill-option" disabled={busy || isBrowserPreview} onClick={() => action(() => api.importSkill(), 'นำเข้า Skill แล้ว', { closeModal: true })}><span className="add-skill-option-icon"><FolderOpen size={18} /></span><span className="add-skill-option-copy"><strong>นำเข้าจากโฟลเดอร์</strong><small>เลือกโฟลเดอร์ที่มีไฟล์ SKILL.md</small></span><ChevronRight size={17} /></button><p className="help-text add-skill-options-note">{isBrowserPreview ? 'นำเข้าจาก Git repository และโฟลเดอร์ได้ในแอป Windows' : 'การนำเข้าจาก repository จะเก็บแหล่งที่มาไว้ให้อัปเดตได้'}</p></div><footer className="modal-footer"><button className="button" disabled={busy} onClick={() => setModal(null)}>ปิด</button></footer></Modal>}
    {modal?.type === 'skill' && <SkillEditor skill={modal.skill} busy={busy} error={notice?.error ? notice.message : null} onClose={() => setModal(null)} onSave={(input) => action(() => api.saveSkill({ id: input.id, name: input.name.trim(), description: input.description.trim(), category: input.category.trim(), content: input.content }), 'บันทึก Skill แล้ว', { closeModal: true })} />}
    {modal?.type === 'discovery' && <Modal title="Skill บนเครื่อง" onClose={() => setModal(null)} busy={busy} error={scanError || (notice?.error ? notice.message : null)} wide><div className="modal-content"><p className="help-text">พบจากโฟลเดอร์ AI ในบัญชี Windows นี้ เลือก Skill ที่ต้องการคัดลอกเข้าคลัง ไฟล์ต้นฉบับจะคงเดิม</p><div className="discovery-tools"><label className="search-field"><Search size={17} /><input type="search" aria-label="ค้นหา Skill ที่พบบนเครื่อง" placeholder="ค้นหาชื่อหรือระบบ AI…" value={foundSearch} onChange={event => setFoundSearch(event.target.value)} /></label><button className="button" disabled={busy || scanning} onClick={refreshDiscovery}>{scanning ? <LoaderCircle size={16} className="spin" /> : <Search size={16} />}ค้นหาใหม่</button></div><div className="discovery-selection"><span>{foundSelection.length} รายการที่เลือก · สูงสุด 200 ต่อครั้ง</span><button className="text-button" disabled={busy || scanning} onClick={() => setFoundSelection((discovery?.items || []).filter(item => !item.imported && `${item.name} ${item.provider} ${item.path}`.toLowerCase().includes(foundSearch.toLowerCase())).slice(0, 200).map(item => item.id))}>เลือกทั้งหมดที่แสดง</button><button className="text-button" disabled={busy || scanning} onClick={() => setFoundSelection([])}>ล้างการเลือก</button></div>{scanning ? <div className="discovery-empty">กำลังอ่านโฟลเดอร์ Skill…</div> : <div className="discovery-list">{(discovery?.items || []).filter(item => `${item.name} ${item.provider} ${item.path}`.toLowerCase().includes(foundSearch.toLowerCase())).map(item => <label className={`discovery-item ${item.imported ? 'already-imported' : ''}`} key={item.id}><input type="checkbox" aria-label={`นำเข้า ${item.name} จาก ${item.provider}`} checked={foundSelection.includes(item.id)} disabled={busy || item.imported || (!foundSelection.includes(item.id) && foundSelection.length >= 200)} onChange={event => setFoundSelection(ids => event.target.checked ? [...ids, item.id] : ids.filter(id => id !== item.id))} /><div><strong>{item.name}</strong><span className="category-tag">{item.provider}</span>{item.imported && <span className="discovery-imported">นำเข้าแล้ว</span>}<p>{item.description || 'ยังไม่มีคำอธิบาย'}</p><code>{item.path}</code></div></label>)}{!(discovery?.items || []).some(item => `${item.name} ${item.provider} ${item.path}`.toLowerCase().includes(foundSearch.toLowerCase())) && <p className="discovery-empty">ไม่พบ Skill ที่ตรงกับการค้นหา ใช้เมนูนำเข้าโฟลเดอร์สำหรับตำแหน่งอื่น</p>}</div>}{discovery?.warnings?.length > 0 && <div className="discovery-warnings" role="status">{discovery.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}<details className="discovery-roots"><summary>ตำแหน่งที่ตรวจสอบ</summary>{(discovery?.roots || []).map((item, index) => <p key={index}><strong>{item.provider}</strong> · {item.status === 'missing' ? 'ไม่มีโฟลเดอร์' : item.status === 'scanned' ? 'ตรวจแล้ว' : 'ตรวจไม่ครบ'}<code>{item.path}</code></p>)}</details></div><footer className="modal-footer"><button className="button" disabled={busy} onClick={() => setModal(null)}>ปิด</button><button className="button primary" disabled={busy || scanning || !foundSelection.length} onClick={importFound}>{busy ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}นำเข้าที่เลือก ({foundSelection.length})</button></footer></Modal>}
    {modal?.type === 'repository' && <RepositoryImport onClose={() => setModal(null)} onImported={(next) => { setState(next); }} />}
    {modal?.type === 'migration' && <TransferMachine initialPreview={modal.preview} onClose={() => setModal(null)} onBeforeRestore={beforeRestore} onRestored={restoredLibrary} />}
    {modal?.type === 'install' && <InstallToAI profile={modal.profile} onClose={() => setModal(null)} />}
    {modal?.type === 'profile' && <ProfileEditor profile={modal.profile} busy={busy} error={notice?.error ? notice.message : null} onClose={() => setModal(null)} onSave={(input) => action(() => api.saveProfile({ ...input, name: input.name.trim() }), 'บันทึกโปรไฟล์แล้ว', { closeModal: true })} />}
    {modal?.type === 'preview' && <Modal title={modal.skill.name} onClose={() => setModal(null)} busy={busy} wide><div className="modal-content"><div className="preview-meta"><span className="category-tag">{modal.skill.category}</span><span>{modal.skill.fileCount} ไฟล์</span><span>อัปเดต {new Date(modal.skill.updatedAt).toLocaleDateString('th-TH')}</span></div><p className="preview-description">{modal.skill.description}</p><RepositoryOrigin originRepo={modal.skill.originRepo} /><pre className="markdown-preview">{modal.skill.content}</pre></div><footer className="modal-footer"><button className="button" onClick={() => setModal(null)}>ปิด</button><button className="button primary" onClick={() => setModal({ type: 'skill', skill: modal.skill })}><Pencil size={16} />แก้ไข Skill</button></footer></Modal>}
  </div>;
}
