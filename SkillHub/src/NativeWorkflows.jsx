import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, CheckCheck, Download, FolderOpen, GitBranch, Github, LoaderCircle, MonitorDown, Search, X } from 'lucide-react';
import { api, isBrowserPreview } from './browser-adapter.js';
import './native-workflows.css';

export function WorkflowModal({ title, busy, error, onClose, children, footer }) {
  const ref = useRef(null);
  const titleId = React.useId();
  useEffect(() => {
    ref.current.showModal();
    const dialog = ref.current;
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} className="modal modal-wide workflow-modal" aria-labelledby={titleId} aria-busy={busy} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="modal-header"><h2 id={titleId}>{title}</h2><button className="icon-button" disabled={busy} aria-label="ปิดหน้าต่าง" onClick={onClose}><X size={19} /></button></header>
    {error && <div className="modal-error" role="alert"><AlertCircle size={17} /><span>{error}</span></div>}
    <div className="modal-content">{children}</div>
    <footer className="modal-footer"><button className="button" disabled={busy} onClick={onClose}>ปิด</button>{footer}</footer>
  </dialog>;
}

export function WarningList({ warnings }) {
  if (!warnings?.length) return null;
  return <div className="workflow-warnings" role="status">{warnings.map((warning, index) => <p key={index}><AlertCircle size={14} /><span>{warning}</span></p>)}</div>;
}

export function RepositoryImport({ onClose, onImported }) {
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const [preview, setPreview] = useState(null);
  const [selection, setSelection] = useState([]);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const lock = useRef(false);
  const busy = !!pending;
  function resetPreview() { setPreview(null); setSelection([]); setResult(null); setError(''); }
  async function loadPreview(local = false) {
    if (lock.current) return;
    lock.current = true;
    setPending('preview'); setError(''); setResult(null);
    try {
      const next = await (local ? api.previewLocalRepository() : api.previewRepository({ url: url.trim(), ...(ref.trim() ? { ref: ref.trim() } : {}) }));
      if (next) { setPreview(next); setSelection(next.items.slice(0, 200).map(item => item.id)); }
    } catch (failure) { setError(failure.message || 'อ่านรายการ Skill จากคลังโค้ดไม่สำเร็จ'); setPreview(null); setSelection([]); }
    finally { setPending(''); lock.current = false; }
  }
  async function importSelection() {
    if (lock.current || !preview || !selection.length) return;
    lock.current = true;
    setPending('import'); setError(''); setResult(null);
    try {
      const next = await api.importRepository({ repoId: preview.id, skillIds: [...selection] });
      setResult(next);
      setSelection([]);
      onImported(next.state);
    } catch (failure) { setError(failure.message || 'นำเข้า Skill จากคลังโค้ดไม่สำเร็จ'); }
    finally { setPending(''); lock.current = false; }
  }
  return <WorkflowModal title="นำเข้าจากคลังโค้ด" busy={busy} error={error} onClose={onClose} footer={<button className="button primary" disabled={busy || isBrowserPreview || !preview || !selection.length} onClick={importSelection}>{pending === 'import' ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}นำเข้าที่เลือก ({selection.length})</button>}>
    <p className="help-text">เลือกคลัง GitHub สาธารณะ หรือโฟลเดอร์คลังโค้ดบนเครื่อง ตรวจรายการก่อนคัดลอกเข้า Skill Hub โดยไม่รันโค้ดจากคลัง</p>
    {isBrowserPreview && <div className="workflow-warnings"><p><AlertCircle size={15} /><span>นำเข้าคลังโค้ดได้ในแอป Windows เท่านั้น</span></p></div>}
    <form className="repository-form" onSubmit={event => { event.preventDefault(); loadPreview(); }}>
      <label>URL คลัง GitHub<input type="url" required autoFocus value={url} maxLength={500} placeholder="https://github.com/owner/repository" disabled={busy || isBrowserPreview} onChange={event => { setUrl(event.target.value); resetPreview(); }} /></label>
      <div className="repository-ref"><label>สาขา แท็ก หรือ commit <span className="optional-label">(ไม่บังคับ)</span><input value={ref} maxLength={200} placeholder="เว้นว่างเพื่อใช้สาขาหลัก" disabled={busy || isBrowserPreview} onChange={event => { setRef(event.target.value); resetPreview(); }} /></label><button className="button" type="submit" disabled={busy || isBrowserPreview || !url.trim()}>{pending === 'preview' ? <LoaderCircle size={16} className="spin" /> : <Github size={16} />}ตรวจคลัง GitHub</button></div>
    </form>
    <div className="repository-local"><span>หรือเลือกจากเครื่องของคุณ</span><button className="button" disabled={busy || isBrowserPreview} onClick={() => loadPreview(true)}><FolderOpen size={16} />เลือกโฟลเดอร์คลังโค้ด</button></div>
    {pending === 'preview' && <div className="workflow-loading" role="status"><LoaderCircle size={18} className="spin" />กำลังค้นหา SKILL.md และเตรียมสำเนาสำหรับตรวจสอบ…</div>}
    {preview && <section className="repository-preview" aria-label="รายการ Skill จากคลังโค้ด">
      <div className="repository-source"><GitBranch size={17} /><div><strong>{preview.url}</strong><p>{preview.ref || 'โฟลเดอร์บนเครื่อง'}</p>{preview.commit ? <code>commit: {preview.commit}</code> : <span className="help-text">สำเนาจากโฟลเดอร์ที่เลือก ไม่มี commit ที่ยืนยัน</span>}</div></div>
      <WarningList warnings={preview.warnings} />
      <div className="discovery-selection"><span>พบ {preview.items.length} Skill · เลือก {selection.length} · สูงสุด 200 ต่อครั้ง</span><button className="text-button" disabled={busy} onClick={() => setSelection(preview.items.slice(0, 200).map(item => item.id))}>เลือกทั้งหมด</button><button className="text-button" disabled={busy} onClick={() => setSelection([])}>ล้างการเลือก</button></div>
      <div className="discovery-list repository-items">{preview.items.map(item => <label className="discovery-item" key={item.id}><input type="checkbox" aria-label={`นำเข้า ${item.name} จากคลังโค้ด`} checked={selection.includes(item.id)} disabled={busy || (!selection.includes(item.id) && selection.length >= 200)} onChange={event => setSelection(ids => event.target.checked ? [...ids, item.id] : ids.filter(id => id !== item.id))} /><div><strong>{item.name}</strong><p>{item.description || 'ยังไม่มีคำอธิบาย'}</p><code>{item.path}</code></div></label>)}{!preview.items.length && <p className="discovery-empty">ไม่พบโฟลเดอร์ที่มี SKILL.md ในคลังนี้</p>}</div>
    </section>}
    {result && <section className="workflow-results" aria-label="ผลการนำเข้าคลังโค้ด"><h3><CheckCheck size={18} />นำเข้าแล้ว {result.importedCount} Skill</h3>{!!result.failures?.length && <div role="alert"><p>นำเข้าไม่สำเร็จ {result.failures.length} รายการ</p><ul>{result.failures.map((item, index) => <li key={index}><strong>{item.name}</strong>: {item.error}</li>)}</ul></div>}</section>}
  </WorkflowModal>;
}

const statusText = { new: 'ติดตั้งใหม่', update: 'อัปเดต', unchanged: 'เหมือนเดิม', conflict: 'ติดตั้งไม่ได้' };

export function InstallToAI({ profile, onClose }) {
  const [targets, setTargets] = useState([]);
  const [selection, setSelection] = useState([]);
  const [pending, setPending] = useState('detect');
  const [error, setError] = useState('');
  const [plan, setPlan] = useState(null);
  const [result, setResult] = useState(null);
  const lock = useRef(false);
  const busy = !!pending;
  useEffect(() => {
    let active = true;
    if (isBrowserPreview) { setPending(''); return; }
    api.detectTargets().then(next => {
      if (!active) return;
      setTargets(next);
      setSelection(next.filter(target => target.detected && target.supported).map(target => target.id));
    }).catch(failure => { if (active) setError(failure.message || 'ตรวจหาระบบ AI บนเครื่องไม่สำเร็จ'); }).finally(() => { if (active) setPending(''); });
    return () => { active = false; };
  }, []);
  function toggleTarget(id) {
    setSelection(ids => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]);
    setPlan(null); setResult(null); setError('');
  }
  async function makePlan() {
    if (lock.current || !selection.length) return;
    lock.current = true; setPending('plan'); setPlan(null); setResult(null); setError('');
    try { setPlan(await api.planInstallation({ profileId: profile.id, targetIds: [...selection] })); }
    catch (failure) { setError(failure.message || 'ตรวจแผนการติดตั้งไม่สำเร็จ'); }
    finally { setPending(''); lock.current = false; }
  }
  async function install() {
    if (lock.current || !plan) return;
    lock.current = true; setPending('install'); setError(''); setResult(null);
    try { setResult(await api.applyInstallation(plan.id)); setPlan(null); }
    catch (failure) { setError(failure.message || 'ติดตั้งไม่สำเร็จ กรุณาตรวจแผนการติดตั้งใหม่'); setPlan(null); }
    finally { setPending(''); lock.current = false; }
  }
  const actionable = plan?.entries.some(entry => entry.status === 'new' || entry.status === 'update');
  return <WorkflowModal title={`ติดตั้งชุด Skill ให้ AI · ${profile.name}`} busy={busy} error={error} onClose={onClose} footer={plan ? <button className="button primary" disabled={busy || !actionable} onClick={install}>{pending === 'install' ? <LoaderCircle size={16} className="spin" /> : <MonitorDown size={16} />}ติดตั้งให้ AI ที่เลือกทั้งหมด</button> : !result ? <button className="button primary" disabled={busy || isBrowserPreview || !selection.length} onClick={makePlan}>{pending === 'plan' ? <LoaderCircle size={16} className="spin" /> : <Search size={16} />}ตรวจแผนการติดตั้ง</button> : null}>
    <p className="help-text">ใช้ชุดที่บันทึกไว้ {profile.skillIds.length} Skill ติดตั้งเฉพาะระบบที่พบบนเครื่อง เลือกปลายทางแล้วตรวจแผนก่อนเขียนไฟล์จริง</p>
    <div className="workflow-scope"><AlertCircle size={16} /><p>รองรับโปรแกรม AI บนเครื่องเท่านั้น Claude หมายถึง Claude Code ไม่ใช่ Cowork และไม่สามารถติดตั้งเข้า ChatGPT หรือบัญชีคลาวด์ได้</p></div>
    {isBrowserPreview && <div className="workflow-warnings"><p>ติดตั้ง Skill ได้ในแอป Windows เท่านั้น</p></div>}
    {pending === 'detect' && <div className="workflow-loading" role="status"><LoaderCircle size={18} className="spin" />กำลังตรวจหาระบบ AI และตำแหน่ง Skill…</div>}
    {!result && <div className="install-targets" aria-label="ระบบ AI ปลายทาง">{targets.map(target => <label key={target.id} className={`install-target ${!target.detected || !target.supported ? 'target-unavailable' : ''}`}><input type="checkbox" aria-label={`ติดตั้งให้ ${target.name}`} checked={selection.includes(target.id)} disabled={busy || !target.detected || !target.supported} onChange={() => toggleTarget(target.id)} /><div><div className="target-heading"><strong>{target.name}</strong><span>{!target.supported ? 'ไม่รองรับ' : target.detected ? 'พบในเครื่อง' : 'ยังไม่พบในเครื่อง'}</span></div>{target.path && <code>{target.path}</code>}{target.evidence?.length > 0 && <ul className="target-evidence">{target.evidence.map((evidence, index) => <li key={index}>{evidence}</li>)}</ul>}{target.note && <p>{target.note}</p>}{!target.detected && target.supported && !target.note && <p>ยังไม่พบโปรแกรมหรือโฟลเดอร์ตั้งค่าที่รองรับ</p>}</div></label>)}</div>}
    {pending === 'plan' && <div className="workflow-loading" role="status"><LoaderCircle size={18} className="spin" />กำลังตรวจชื่อ Skill และไฟล์ปลายทาง…</div>}
    {plan && <section className="installation-plan" aria-label="แผนการติดตั้ง"><div className="plan-heading"><h3>แผนการติดตั้ง · {plan.profileName}</h3><span>{plan.entries.length} รายการ</span></div><WarningList warnings={plan.warnings} /><div className="plan-entries">{plan.entries.map((entry, index) => <article className={`plan-entry plan-${entry.status}`} key={`${entry.targetId}-${entry.skillId}-${index}`}><div><strong>{entry.skillName}</strong><span className={`plan-status status-${entry.status}`}>{statusText[entry.status] || entry.status}</span></div><p>{entry.targetName}</p><code>{entry.folder}</code>{entry.reason && <p className="plan-reason">{entry.reason}</p>}</article>)}</div>{!plan.entries.length && <p className="help-text">ไม่มีรายการให้ติดตั้งในแผนนี้</p>}{plan.entries.some(entry => entry.status === 'conflict') && <p className="help-text">รายการที่ติดตั้งไม่ได้จะไม่ถูกเขียนทับ ตรวจเหตุผลของแต่ละรายการก่อนดำเนินการ</p>}{!actionable && plan.entries.length > 0 && !plan.entries.some(entry => entry.status === 'conflict') && <div className="workflow-complete"><Check size={18} />ไฟล์ปลายทางตรงกับชุดนี้แล้ว ไม่ต้องติดตั้งซ้ำ</div>}</section>}
    {pending === 'install' && <div className="workflow-loading" role="status"><LoaderCircle size={18} className="spin" />กำลังติดตั้งและตรวจสอบไฟล์ กรุณารอจนเสร็จ…</div>}
    {result && <section className="workflow-results" aria-label="ผลการติดตั้ง"><h3><CheckCheck size={19} />ติดตั้งแล้ว {result.installedCount} รายการ</h3><p>ไฟล์เหมือนเดิม {result.unchangedCount} รายการ</p>{!!result.failures?.length && <div className="installation-failures" role="alert"><h4>ติดตั้งไม่สำเร็จ {result.failures.length} รายการ</h4><ul>{result.failures.map((failure, index) => <li key={index}><strong>{failure.targetName} · {failure.skillName}</strong><p>{failure.error}</p></li>)}</ul></div>}{!!result.backups?.length && <details className="installation-backups" open><summary>สำรองข้อมูลก่อนอัปเดต {result.backups.length} ตำแหน่ง</summary>{result.backups.map((path, index) => <code key={index}>{path}</code>)}</details>}{result.restartNote && <p className="restart-note">{result.restartNote}</p>}</section>}
  </WorkflowModal>;
}
