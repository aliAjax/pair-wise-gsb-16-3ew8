import { ReactNode, useMemo, useState } from "react";
import "./styles.css";
import {
  Appointment,
  AuditEntry,
  ConfirmResult,
  FIELD_KEYS,
  FIELD_LABELS,
  FieldKey,
  FittingChain,
  StockMovement,
} from "./domain";
import { bootDemoChain, DAY1, loadOfflineFollowUps } from "./demo";

const AUDIT_LABELS: Record<AuditEntry["type"], string> = {
  "record-created": "建档",
  "revision-merged": "修订合并",
  "revision-conflict": "修订冲突",
  "revision-duplicate": "重复修订",
  "batch-confirmed": "主管确认",
  "appointment-invalidated": "预约失效",
  "appointment-rebooked": "重新排诊",
  "appointment-deferred": "容量顺延",
  "stock-reserved": "设备预占",
  "stock-released": "预占释放",
  "stock-movement": "库存流水",
  "batch-rolled-back": "批次回滚",
};

function fmtTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function Badge({ tone, children }: { tone: "ok" | "warn" | "danger" | "muted" | "info"; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export default function App() {
  const [chain, setChain] = useState<FittingChain>(() => bootDemoChain());
  const [, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);
  const reset = () => {
    setChain(bootDemoChain());
    setSelected("rec-liu-024");
  };

  const [selected, setSelected] = useState("rec-liu-024");
  const record = chain.getRecord(selected);

  // 离线修订表单
  const [author, setAuthor] = useState("听力师甲");
  const [basis, setBasis] = useState("");
  const [drafts, setDrafts] = useState<Partial<Record<FieldKey, string>>>({});
  const [confirmNote, setConfirmNote] = useState("");
  const [failInject, setFailInject] = useState(false);
  const [lastResult, setLastResult] = useState<ConfirmResult | null>(null);
  const [timelinePatient, setTimelinePatient] = useState<string>("P-024");
  const [inboundModel, setInboundModel] = useState("RIC-200");

  const effective = record.getEffective();
  const pending = record.getPendingBatch();
  const unresolved = record.unresolvedConflicts();
  const revisions = record.listRevisions();

  const appointments = chain.scheduler.listAppointments();
  const movements = chain.ledger.listMovements();
  const timeline = useMemo(() => chain.timeline(timelinePatient), [chain, timelinePatient]);

  function submitOfflineRevision() {
    const changes = Object.fromEntries(
      Object.entries(drafts).filter(([, v]) => v !== undefined && v.trim() !== ""),
    ) as Partial<Record<FieldKey, string>>;
    if (Object.keys(changes).length === 0 || basis.trim() === "") return;
    chain.revise(selected, {
      clientId: `rev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      author,
      baseSeq: effective.seq,
      basis: basis.trim(),
      changes,
      at: Date.now(),
    });
    setDrafts({});
    setBasis("");
    refresh();
  }

  function resolveField(field: FieldKey, seqRaw: string) {
    chain.resolveConflict(selected, field, Number(seqRaw), "门店主管·周敏");
    refresh();
  }

  function confirmBatch() {
    if (unresolved.length > 0) return;
    const result = chain.confirm(
      selected,
      "门店主管·周敏",
      Date.now(),
      confirmNote.trim() || "主管确认放行",
      { failAtAssignment: failInject ? 0 : undefined },
    );
    setLastResult(result);
    setConfirmNote("");
    setFailInject(false);
    refresh();
  }

  function retryDeferred() {
    const result = chain.retryDeferred(selected, Date.now());
    if (result) setLastResult(result);
    refresh();
  }

  function inbound() {
    chain.ledger.inbound(inboundModel, 1, Date.now(), "门店紧急调拨");
    refresh();
  }

  return (
    <main className="app-shell workbench">
      <header className="wb-hero panel">
        <div>
          <p className="eyebrow">hxwl-01 · 可续作的验配链</p>
          <h1>断网复诊 · 修订合并与占机排诊联动工作台</h1>
          <p className="subtitle">
            听力师断网改记录 → 回连按修订序号三方合并 → 冲突全留待主管裁决 →
            有效结论换版后旧预约/旧预占自动失效重算 → 容量不足分批、写入失败整批回滚 → 全程可追查。
          </p>
        </div>
        <div className="wb-hero-actions">
          <button onClick={() => { loadOfflineFollowUps(chain); refresh(); }}>
            ① 模拟两人断网复诊
          </button>
          <button onClick={reset}>重置演示现场</button>
        </div>
      </header>

      <nav className="record-tabs">
        {["rec-liu-024", "rec-chen-118"].map((id) => {
          const r = chain.getRecord(id);
          const eff = r.getEffective();
          return (
            <button
              key={id}
              className={id === selected ? "active" : ""}
              onClick={() => { setSelected(id); setTimelinePatient(r.patientId); setLastResult(null); }}
            >
              <strong>{r.patientName}</strong>
              <span>{id} · 有效结论 v{eff.version} / seq {eff.seq}</span>
              {r.hasOpenBatch() && <em className="dot dot-danger" />}
            </button>
          );
        })}
      </nav>

      {lastResult && (
        <section className={`panel result-banner ${lastResult.committed ? "ok" : "danger"}`}>
          <strong>
            {lastResult.committed
              ? `批次 ${lastResult.batchId} 已整批提交`
              : `批次 ${lastResult.batchId} 写入失败，已从完整批次回滚`}
          </strong>
          <ul>
            {lastResult.changedFields.length > 0 && (
              <li>结论升至 v{lastResult.version}，变化字段：{lastResult.changedFields.map((f) => FIELD_LABELS[f]).join("、")}</li>
            )}
            {lastResult.invalidated.length > 0 && <li>失效旧预约：{lastResult.invalidated.join("、")}（设备预占已释放）</li>}
            <li>重算可兑现 {lastResult.planned.assignments.length} 条，顺延 {lastResult.planned.deferred.length} 条</li>
            {!lastResult.committed && <li>失败原因：{lastResult.error}；结论已换版，点“重试顺延批次”即可续作</li>}
          </ul>
        </section>
      )}

      <div className="wb-grid">
        <div className="wb-main">
          {/* 当前有效结论 */}
          <section className="panel">
            <div className="section-heading">
              <div>
                <p>当前有效结论</p>
                <h2>{record.patientName} · v{effective.version}（seq {effective.seq}）</h2>
              </div>
              {pending
                ? <Badge tone="danger">有待确认修订，未覆盖本结论</Badge>
                : <Badge tone="ok">结论有效，占机排诊以此为准</Badge>}
            </div>
            {effective.confirmedBy && (
              <p className="muted small">
                {fmtTime(effective.confirmedAt ?? 0)} 由 {effective.confirmedBy} 确认 · {effective.rationale}
              </p>
            )}
            <div className="kv-grid">
              {FIELD_KEYS.map((f) => (
                <div key={f} className="kv">
                  <span>{FIELD_LABELS[f]}</span>
                  <strong>{effective.values[f]}</strong>
                </div>
              ))}
            </div>
          </section>

          {/* 离线修订 */}
          <section className="panel">
            <div className="section-heading">
              <div>
                <p>离线修订 · 回连提交</p>
                <h2>基于 seq {effective.seq} 的修订将按序号并入</h2>
              </div>
            </div>
            <div className="rev-form">
              <label className="inline">
                <span>听力师</span>
                <select value={author} onChange={(e) => setAuthor(e.target.value)}>
                  <option>听力师甲</option>
                  <option>听力师乙</option>
                </select>
              </label>
              <label className="grow">
                <span>变更依据（复测数据 / 用户主诉，确认后可追查）</span>
                <input
                  placeholder="例：10-05 门店复测，高频增益建议 +4dB"
                  value={basis}
                  onChange={(e) => setBasis(e.target.value)}
                />
              </label>
            </div>
            <div className="field-grid">
              {FIELD_KEYS.map((f) => (
                <label key={f}>
                  <span>{FIELD_LABELS[f]}（留空不改）</span>
                  <input
                    placeholder={`当前：${effective.values[f]}`}
                    value={drafts[f] ?? ""}
                    onChange={(e) => setDrafts((d) => ({ ...d, [f]: e.target.value }))}
                  />
                </label>
              ))}
            </div>
            <div className="row-actions">
              <button className="primary-action" onClick={submitOfflineRevision}>
                ② 回连提交修订
              </button>
              <span className="muted small">同字段两人不同值会全部保留为候选，不会覆盖有效结论</span>
            </div>
          </section>

          {/* 待确认批次 */}
          {pending && (
            <section className="panel pending-panel">
              <div className="section-heading">
                <div>
                  <p>待主管确认 · {pending.id}</p>
                  <h2>修订序号 {pending.revisionSeqs.join("、")} 的三方合并结果</h2>
                </div>
                {unresolved.length > 0
                  ? <Badge tone="danger">{unresolved.length} 个冲突未裁决</Badge>
                  : <Badge tone="ok">冲突已裁决，可放行</Badge>}
              </div>

              <div className="candidate-list">
                {Object.entries(pending.fields).map(([field, pf]) => {
                  if (!pf) return null;
                  const isConflict = pf.candidates.filter((c) => c.value !== pf.baseValue).length >= 2;
                  const chosen = pf.resolvedValue;
                  return (
                    <div key={field} className={`candidate ${isConflict ? "conflict" : "clean"}`}>
                      <div className="candidate-head">
                        <strong>{FIELD_LABELS[field as FieldKey]}</strong>
                        {isConflict
                          ? <Badge tone="warn">冲突 · 全部留档</Badge>
                          : <Badge tone="muted">单方修改</Badge>}
                        {chosen !== undefined && <Badge tone="ok">已裁决</Badge>}
                      </div>
                      <div className="candidate-options">
                        {pf.candidates.map((c) => {
                          const id = `${pf.field}-${c.seq}-${c.value}`;
                          return (
                            <label key={id} className="radio-row">
                              <input
                                type="radio"
                                name={pf.field}
                                checked={chosen === c.value}
                                onChange={() => resolveField(field as FieldKey, String(c.seq))}
                              />
                              <span className="candidate-value">{c.value}</span>
                              <span className="muted small">
                                {c.author} · seq {c.seq}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                      {isConflict && (
                        <p className="muted small">
                          当前有效值“{pf.baseValue}”同时保留，主管可裁决维持旧结论。
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="confirm-row">
                <input
                  className="grow"
                  placeholder="确认依据（例：以甲的复测曲线为准，升级机型重排试听）"
                  value={confirmNote}
                  onChange={(e) => setConfirmNote(e.target.value)}
                />
                <label className="check-row">
                  <input type="checkbox" checked={failInject} onChange={(e) => setFailInject(e.target.checked)} />
                  模拟设备写入失败
                </label>
                <button
                  className="primary-action"
                  disabled={unresolved.length > 0}
                  onClick={confirmBatch}
                >
                  ③ {unresolved.length > 0 ? "冲突未裁决，禁止覆盖" : "主管确认并联动重排"}
                </button>
              </div>
            </section>
          )}

          {/* 修订序号链 */}
          <section className="panel">
            <div className="section-heading">
              <div>
                <p>修订序号链（旧修订归档不删除）</p>
                <h2>{record.patientName} 的全部修订</h2>
              </div>
            </div>
            <table className="data-table">
              <thead>
                <tr><th>seq</th><th>听力师</th><th>base</th><th>合并字段</th><th>冲突字段</th><th>依据</th><th>状态</th></tr>
              </thead>
              <tbody>
                {revisions.map((r) => (
                  <tr key={r.seq}>
                    <td>{r.seq}</td>
                    <td>{r.author}</td>
                    <td>{r.baseSeq}</td>
                    <td>{r.mergedFields.join("、") || "—"}</td>
                    <td>{r.conflictFields.length > 0
                      ? <Badge tone="danger">{r.conflictFields.map((f) => FIELD_LABELS[f]).join("、")}</Badge>
                      : "—"}</td>
                    <td className="basis-cell">{r.basis}</td>
                    <td>{r.archived ? <Badge tone="muted">已归档</Badge> : <Badge tone="info">待确认</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>

        <aside className="wb-side">
          {/* 复诊预约 */}
          <section className="panel">
            <div className="section-heading">
              <div>
                <p>复诊预约（{DAY1}）</p>
                <h2>未执行预约随结论失效重算</h2>
              </div>
            </div>
            <ul className="appt-list">
              {appointments.map((a: Appointment) => (
                <li key={a.id} className={`appt appt-${a.status}`}>
                  <div>
                    <strong>{a.id}</strong>
                    <span>{a.date} · {a.model} · {a.patientId}</span>
                    {a.invalidatedReason && <em>{a.invalidatedReason}</em>}
                  </div>
                  {a.status === "scheduled" && <Badge tone="ok">已占机</Badge>}
                  {a.status === "invalidated" && <Badge tone="danger">已失效</Badge>}
                  {a.status === "deferred" && <Badge tone="warn">顺延</Badge>}
                </li>
              ))}
            </ul>
            <button onClick={retryDeferred}>重试顺延批次（按当前容量重算）</button>
          </section>

          {/* 试听设备台账 */}
          <section className="panel">
            <div className="section-heading">
              <div>
                <p>试听设备台账</p>
                <h2>{DAY1} 容量与流水</h2>
              </div>
            </div>
            <table className="data-table compact">
              <thead><tr><th>型号</th><th>在店</th><th>已预占</th><th>当日可试听</th></tr></thead>
              <tbody>
                {["RIC-200", "RIC-300"].map((m) => (
                  <tr key={m}>
                    <td>{m}</td>
                    <td>{chain.ledger.getOnHand(m)}</td>
                    <td>{chain.ledger.reserved(m, DAY1)}</td>
                    <td>{chain.ledger.capacityFor(m, DAY1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row-actions">
              <select value={inboundModel} onChange={(e) => setInboundModel(e.target.value)}>
                <option>RIC-200</option>
                <option>RIC-300</option>
              </select>
              <button onClick={inbound}>调拨入库 1 台</button>
            </div>
            <details className="movements">
              <summary>库存流水（只增不改，{movements.length} 条）</summary>
              <ul>
                {[...movements].reverse().map((m: StockMovement) => (
                  <li key={m.id}>
                    <Badge tone={m.type === "release" ? "danger" : m.type === "reserve" ? "info" : "muted"}>
                      {m.type}
                    </Badge>
                    {m.model} ×{m.qty} {m.date && `· ${m.date}`} — {m.reason}
                  </li>
                ))}
              </ul>
            </details>
          </section>

          {/* 审计时间线 */}
          <section className="panel">
            <div className="section-heading">
              <div>
                <p>主管追查 · 只增时间线</p>
                <h2>修订 / 依据 / 预约 / 库存</h2>
              </div>
              <select value={timelinePatient} onChange={(e) => setTimelinePatient(e.target.value)}>
                <option value="P-024">刘阿姨 P-024</option>
                <option value="P-118">陈大爷 P-118</option>
              </select>
            </div>
            <ol className="timeline">
              {[...timeline].reverse().map((e: AuditEntry) => (
                <li key={e.id}>
                  <div className="timeline-head">
                    <Badge tone={e.type.includes("conflict") || e.type.includes("roll") ? "danger" : "info"}>
                      {AUDIT_LABELS[e.type]}
                    </Badge>
                    <span className="muted small">{fmtTime(e.at)} · {e.author}</span>
                  </div>
                  {e.rationale && <p>{e.rationale}</p>}
                  {e.refs && (
                    <p className="muted small refs">
                      {Object.entries(e.refs).map(([k, v]) => `${k}=${v}`).join(" · ")}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
    </main>
  );
}
