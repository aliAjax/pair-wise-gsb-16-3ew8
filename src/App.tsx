import { useState } from "react";
import { useChain } from "./state/useChain";
import { RevisionPanel } from "./ui/RevisionPanel";
import { MergePanel } from "./ui/MergePanel";
import { DownstreamPanel } from "./ui/DownstreamPanel";
import { AuditPanel } from "./ui/AuditPanel";
import { fieldLabel } from "./ui/MergePanel";
import type { ConclusionFields } from "./domain/types";
import "./styles.css";

function showValue(f: keyof ConclusionFields, v: unknown): string {
  return Array.isArray(v) ? `第 ${v.join("、")} 天` : String(v);
}

export default function App() {
  const { ctx, act, resetDemo } = useChain();
  const { service, recordId, audiologist1, audiologist2, supervisor } = ctx;
  const [toast, setToast] = useState("");
  const record = service.state.records.find((r) => r.id === recordId)!;
  const stationA = service.state.stations.find((s) => s.id === "station-A")!;
  const stationB = service.state.stations.find((s) => s.id === "station-B")!;

  const flash = (msg: string) => act(() => setToast(msg));
  const refresh = () => act(() => {});

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">hxwl-01 · 可续作的验配链</p>
          <h1>听力验配 · 修订合并与复诊设备联动工作台</h1>
          <p className="subtitle">
            离线修订按序号合并、冲突全留待确认、结论生效后预约与设备预占失效重算、批次失败整批恢复、全程留痕可追查。
          </p>
        </div>
        <div className="stack-card">
          <span>档案</span>
          <strong>
            {record.patientName}（{record.patientId}）
          </strong>
          <small>
            当前有效结论 <b>v{record.current.version}</b>
          </small>
          <button className="mini reset" onClick={resetDemo}>
            重置演示数据
          </button>
        </div>
      </section>

      {toast && (
        <div className="toast" onClick={() => setToast("")}>
          {toast}
        </div>
      )}

      <section className="stations">
        {[
          { s: stationA, who: audiologist1.name },
          { s: stationB, who: audiologist2.name },
        ].map(({ s, who }) => (
          <article key={s.id} className={`station-card ${s.online ? "online" : "offline"}`}>
            <div>
              <strong>{s.name}</strong>
              <small>{who} 使用中</small>
            </div>
            <span className={`pill ${s.online ? "ok" : "off"}`}>
              {s.online ? "在线" : `断网 · 发件箱 ${s.outbox.length} 条待回连`}
            </span>
          </article>
        ))}
        <article className="station-card guide">
          <strong>建议演练顺序</strong>
          <small>
            ① 两工位分别断网各改一版 → ② 回连同步看冲突候选 → ③ 主管裁决写依据并确认 → ④ 观察预约失效重算、设备释放/再占
          </small>
        </article>
      </section>

      <section className="workspace">
        <div className="panel-col">
          <section className="panel">
            <div className="section-heading">
              <div>
                <p>当前有效结论</p>
                <h2>
                  v{record.current.version}
                  {record.pendingMerge && <span className="tag danger ml">有未确认合并，现行结论仍有效</span>}
                </h2>
              </div>
            </div>
            <div className="conclusion-grid">
              {(Object.keys(record.current.fields) as (keyof ConclusionFields)[]).map((f) => (
                <div key={f} className="conc-cell">
                  <span>{fieldLabel(f)}</span>
                  <strong>{showValue(f, record.current.fields[f])}</strong>
                </div>
              ))}
            </div>
            <p className="basis">{record.current.basis}</p>
          </section>

          <section className="panel">
            <RevisionPanel
              service={service}
              recordId={recordId}
              actor={audiologist1}
              actorRole="audiologist1"
              onDone={refresh}
            />
          </section>

          <section className="panel">
            <RevisionPanel
              service={service}
              recordId={recordId}
              actor={audiologist2}
              actorRole="audiologist2"
              onDone={refresh}
            />
          </section>
        </div>

        <div className="panel-col">
          <section className="panel">
            <MergePanel service={service} recordId={recordId} supervisor={supervisor} onDone={(m) => flash(m ?? "已确认")} />
          </section>

          <section className="panel">
            <DownstreamPanel service={service} recordId={recordId} supervisor={supervisor} onDone={(m) => flash(m ?? "")} />
          </section>

          <section className="panel">
            <AuditPanel service={service} recordId={recordId} />
          </section>
        </div>
      </section>
    </main>
  );
}
