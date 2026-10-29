import React, { useRef, useState } from 'react';
import { AlertCircle, ArchiveRestore, CheckCheck, Download, FolderOpen, Laptop, LoaderCircle, Package, Upload } from 'lucide-react';
import { api, isBrowserPreview } from './browser-adapter.js';
import { WarningList, WorkflowModal } from './NativeWorkflows.jsx';
import './transfer-machine.css';

export default function TransferMachine({ initialPreview = null, onClose, onBeforeRestore, onRestored }) {
  const [preview, setPreview] = useState(initialPreview);
  const [autoInstall, setAutoInstall] = useState(true);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [exportResult, setExportResult] = useState(null);
  const [restoreResult, setRestoreResult] = useState(null);
  const lock = useRef(false);
  const busy = !!pending;

  async function exportTransfer() {
    if (lock.current) return;
    lock.current = true; setPending('export'); setError(''); setExportResult(null);
    try {
      const result = await api.exportMigration();
      if (result) setExportResult(result);
    } catch (failure) { setError(failure.message || 'สร้างโฟลเดอร์ย้ายเครื่องไม่สำเร็จ'); }
    finally { lock.current = false; setPending(''); }
  }

  async function openTransfer() {
    if (lock.current) return;
    lock.current = true; setPending('preview'); setError('');
    try {
      const result = await api.previewMigration();
      if (result) { setPreview(result); setRestoreResult(null); setAutoInstall(true); }
    } catch (failure) { setError(failure.message || 'อ่านชุดย้ายเครื่องไม่สำเร็จ'); }
    finally { lock.current = false; setPending(''); }
  }

  async function restoreTransfer() {
    if (lock.current || !preview) return;
    if (onBeforeRestore && !onBeforeRestore()) return;
    lock.current = true; setPending('restore'); setError(''); setRestoreResult(null);
    try {
      const result = await api.restoreMigration({ previewId: preview.id, autoInstall });
      setRestoreResult(result);
      onRestored(result.state);
    } catch (failure) { setError(failure.message || 'นำเข้าชุดย้ายเครื่องไม่สำเร็จ กรุณาตรวจข้อมูลแล้วลองอีกครั้ง'); }
    finally { lock.current = false; setPending(''); }
  }

  return <WorkflowModal title="ย้ายเครื่อง" busy={busy} error={error} onClose={onClose} footer={preview && !restoreResult ? <button className="button primary" disabled={busy || isBrowserPreview} onClick={restoreTransfer}>{pending === 'restore' ? <LoaderCircle size={16} className="spin" /> : <ArchiveRestore size={16} />}{autoInstall ? 'นำเข้าและติดตั้งให้ AI' : 'นำเข้าเฉพาะคลังและโปรไฟล์'}</button> : null}>
    <p className="help-text">สร้างโฟลเดอร์ย้ายเครื่อง แล้วคัดลอกทั้งโฟลเดอร์ไป Windows อีกเครื่อง ข้อมูลจะรวมกับคลังเดิมโดยไม่ลบ Skill และโปรไฟล์ที่มีอยู่</p>
    {isBrowserPreview && <WarningList warnings={['การย้ายเครื่องใช้ได้ในแอป Windows ข้อมูลตัวอย่างในเบราว์เซอร์ไม่รวมกับข้อมูลแอป']} />}
    <div className="transfer-actions"><section><span className="transfer-symbol"><Upload size={23} /></span><h3>เตรียมจากเครื่องนี้</h3><p>รวม Skill ไฟล์ประกอบ และโปรไฟล์ไว้ในชุดเดียว พร้อมตัวแอปเมื่อเปิดจากรุ่นพกพา</p><button className="button" disabled={busy || isBrowserPreview} onClick={exportTransfer}>{pending === 'export' ? <LoaderCircle size={16} className="spin" /> : <Package size={16} />}สร้างโฟลเดอร์ย้ายเครื่อง</button></section><section><span className="transfer-symbol"><Download size={23} /></span><h3>นำเข้าที่เครื่องนี้</h3><p>เปิดไฟล์ .skillhub เพื่อตรวจข้อมูลและระบบ AI ที่เครื่องนี้รองรับก่อนนำเข้า</p><button className="button" disabled={busy || isBrowserPreview} onClick={openTransfer}>{pending === 'preview' ? <LoaderCircle size={16} className="spin" /> : <FolderOpen size={16} />}เปิดชุดย้ายเครื่อง</button></section></div>
    {pending && <div className="workflow-loading" role="status"><LoaderCircle size={18} className="spin" />{pending === 'export' ? 'กำลังสร้างชุดย้ายเครื่องและตรวจไฟล์…' : pending === 'preview' ? 'กำลังตรวจชุดย้ายเครื่องและระบบ AI ปลายทาง…' : 'กำลังรวมข้อมูลและติดตั้งตามตัวเลือก กรุณารอจนเสร็จ…'}</div>}
    {exportResult && <section className="workflow-results transfer-export" aria-label="ผลการสร้างชุดย้ายเครื่อง"><h3><CheckCheck size={18} />สร้างโฟลเดอร์ย้ายเครื่องแล้ว</h3><p>{exportResult.skillCount} Skill · {exportResult.profileCount} โปรไฟล์</p><div className="transfer-path"><strong>โฟลเดอร์ที่ต้องคัดลอก</strong><code>{exportResult.path}</code></div><div className="transfer-path"><strong>ไฟล์ชุดข้อมูล</strong><code>{exportResult.packagePath}</code></div><p>{exportResult.appIncluded ? 'รวมตัวแอปรุ่นพกพาแล้ว คัดลอกทั้งโฟลเดอร์ไปเครื่องใหม่และเปิดแอปจากโฟลเดอร์นั้น' : 'ชุดนี้ไม่มีตัวแอป ให้เปิด Skill Hub บนเครื่องใหม่แล้วเลือกไฟล์ชุดข้อมูลนี้'}</p><WarningList warnings={exportResult.warnings} /></section>}
    {preview && <section className="transfer-preview" aria-label="ข้อมูลชุดย้ายเครื่อง"><div className="transfer-preview-heading"><Laptop size={19} /><div><h3>พร้อมนำเข้าที่เครื่องนี้</h3><p>{preview.skillCount} Skill · {preview.profileCount} โปรไฟล์{preview.createdAt ? ` · สร้าง ${new Date(preview.createdAt).toLocaleString('th-TH')}` : ''}</p></div></div>{preview.alreadyRestored && <WarningList warnings={['เคยนำเข้าชุดนี้แล้ว การนำเข้าซ้ำจะใช้ข้อมูลที่รวมไว้ และลองติดตั้งส่วนที่ยังไม่สำเร็จตามตัวเลือก']} />}<WarningList warnings={preview.warnings} />
      <div className="transfer-deployments"><h4>ระบบ AI ปลายทางของชุดนี้</h4>{preview.deployments.length ? preview.deployments.map((target, index) => <article className="transfer-target" key={`${target.targetId}-${index}`}><div><strong>{target.targetName}</strong><span>{target.skillCount} Skill</span><span className={`plan-status ${target.detected && target.supported ? 'status-new' : 'status-conflict'}`}>{!target.supported ? 'ไม่รองรับ' : target.detected ? 'พบในเครื่องนี้' : 'ยังไม่พบในเครื่องนี้'}</span></div>{target.note && <p>{target.note}</p>}</article>) : <p className="help-text">ไม่มีระบบ AI ที่บันทึกไว้ในชุดนี้ นำเข้าคลังและโปรไฟล์ได้ แล้วเลือกติดตั้งภายหลัง</p>}</div>
      <label className="transfer-auto-install"><input type="checkbox" checked={autoInstall} disabled={busy || !!restoreResult} onChange={event => setAutoInstall(event.target.checked)} /><span><strong>ติดตั้งให้ AI ที่พบในเครื่องนี้โดยอัตโนมัติ</strong><small>ใช้ชุด Skill ตามปลายทางที่บันทึกไว้ ข้ามระบบที่ไม่พบ ไม่รองรับ หรือไฟล์ที่ขัดแย้ง โดยไม่ใช้ตำแหน่งไฟล์จากเครื่องเดิม</small></span></label>
      <p className="help-text">รองรับระบบ AI บนเครื่อง รวมถึง Claude Code ไม่ใช่ Cowork หรือบัญชี ChatGPT บนคลาวด์</p>
    </section>}
    {restoreResult && <section className="workflow-results transfer-restore" aria-label="ผลการย้ายเครื่อง">
      <h3><CheckCheck size={18} />ผลการนำเข้าชุดย้ายเครื่อง</h3>
      <div className="transfer-result-counts"><span>เพิ่ม {restoreResult.addedSkills} Skill</span><span>เพิ่ม {restoreResult.addedProfiles} โปรไฟล์</span><span>ติดตั้ง {restoreResult.installedCount} รายการ</span><span>ไฟล์เหมือนเดิม {restoreResult.unchangedCount} รายการ</span></div>
      {restoreResult.alreadyRestored && <p>ชุดนี้เคยรวมเข้าคลังแล้ว จึงใช้ข้อมูลเดิมเพื่อหลีกเลี่ยงรายการซ้ำ</p>}
      {restoreResult.missingTargets?.length > 0 && <div className="transfer-skipped"><h4>ข้ามระบบที่ไม่พบหรือไม่รองรับ</h4><ul>{restoreResult.missingTargets.map((name, index) => <li key={index}>{name}</li>)}</ul></div>}
      {restoreResult.failures?.length > 0 && <div className="installation-failures" role="alert"><h4>รายการที่ไม่สำเร็จหรือขัดแย้ง {restoreResult.failures.length} รายการ</h4><ul>{restoreResult.failures.map((failure, index) => <li key={index}>{(failure.targetName || failure.skillName) && <strong>{[failure.targetName, failure.skillName].filter(Boolean).join(' · ')}</strong>}<p>{failure.error}</p></li>)}</ul></div>}
      {restoreResult.backups?.length > 0 && <details className="installation-backups" open><summary>สำรองข้อมูลบนเครื่องนี้ {restoreResult.backups.length} ตำแหน่ง</summary>{restoreResult.backups.map((path, index) => <code key={index}>{path}</code>)}</details>}
      <p className="help-text transfer-result-note">Skill และโปรไฟล์เดิมในเครื่องยังคงอยู่ หากมีรายการที่ติดตั้งไม่สำเร็จ ให้แก้สาเหตุแล้วเปิดชุดย้ายเครื่องนี้อีกครั้งเพื่อลองใหม่</p>
    </section>}
  </WorkflowModal>;
}
