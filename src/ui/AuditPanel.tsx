import { useState } from "react";
import type { ChainService } from "../domain/chain";
import { fmtTime, REVISION_LABEL } from "./labels";

interface Props {
  service: ChainService;
  recordId: string;
}

type Tab = "events" | "revisions" | "versions" | "ledger";

/** 追查面板：旧修订、变更依据、库存流水、事件链全部只追加可查 */
export function AuditPanel({ service, recordId }: Props) {
  const trace = service.trace(recordId);
  const [tab, setTab] = useState<Tab>("events");

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "events", label: "验配链事件", count: trace.events.length },
    { key: "revisions", label: "旧修订归档", count: trace.revisions.length },
    { key: "versions", label: "结论版本与依据", count: trace.versions.length },
    { key: "ledger", label: "库存流水", count: trace.txns.length },
  ];

  return (
    <div className="subpanel audit">
      <div className="subpanel-head">
        <strong>追查审计（只追加，不改写）</strong>
      </div>
      <div className="tabs">
        {tabs.map((t) => (
          <button key={t.key} className={`tab ${tab === t.key ? "active" : ""}`} onClick={() => setTab(t.key)}>
            {t.label}
            <b>{t.count}</b>
          </button>
        ))}
      </div>

      {tab === "events" && (
        <ol className="timeline">
          {[...trace.events].reverse().map((e) => (
            <li key={e.id} className="tl-item">
              <span className="tl-seq">#{e.seq}</span>
              <div>
                <div className="tl-title">{e.summary}</div>
                <small className="sub">
                  {e.type} · {fmtTime(e.at)}
                </small>
              </div>
            </li>
          ))}
        </ol>
      )}

      {tab === "revisions" && (
        <table className="grid">
          <thead>
            <tr>
              <th>序号</th>
              <th>听力师</th>
              <th>修订字段</th>
              <th>基于版本</th>
              <th>归处</th>
            </tr>
          </thead>
          <tbody>
            {trace.revisions.map((r) => (
              <tr key={r.id}>
                <td>#{r.seq}</td>
                <td>{r.authorName}</td>
                <td className="changes">
                  {Object.entries(r.fields).map(([k, v]) => (
                    <code key={k}>
                      {k}={Array.isArray(v) ? `[${v.join(",")}]` : String(v)}
                    </code>
                  ))}
                </td>
                <td>v{r.baseVersion}</td>
                <td>
                  <span className={`tag ${r.state === "superseded" ? "muted" : "ok"}`}>
                    {REVISION_LABEL[r.state]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "versions" && (
        <div className="version-stack">
          {trace.versions.map((v) => (
            <article key={v.version} className={`version-card ${v.version === trace.record.current.version ? "current" : ""}`}>
              <header>
                <strong>有效结论 v{v.version}</strong>
                {v.version === trace.record.current.version && <span className="tag ok">当前生效</span>}
                <small className="sub">
                  {v.confirmedByName} · {fmtTime(v.confirmedAt)}
                </small>
              </header>
              <ul className="kv">
                <li>机型：{v.fields.aidModel}（{v.fields.ear}）</li>
                <li>增益：{v.fields.gain}</li>
                <li>试听机：{v.fields.trialDevice}</li>
                <li>复诊：第 {v.fields.followUpDays.join("、")} 天</li>
                <li>备注：{v.fields.note}</li>
              </ul>
              <p className="basis">变更依据：{v.basis}</p>
            </article>
          ))}
        </div>
      )}

      {tab === "ledger" && (
        <table className="grid">
          <thead>
            <tr>
              <th>#</th>
              <th>类型</th>
              <th>机型/日期</th>
              <th>数量</th>
              <th>当日结余</th>
              <th>关联</th>
            </tr>
          </thead>
          <tbody>
            {trace.txns.map((t) => (
              <tr key={t.id}>
                <td>{t.seq}</td>
                <td>
                  <span className={`tag txn-${t.type}`}>{t.type}</span>
                </td>
                <td>
                  {t.model}
                  <div className="sub">{t.dueDate}</div>
                </td>
                <td className={t.qty < 0 ? "neg" : ""}>{t.qty > 0 ? "+" : ""}
                  {t.qty}
                </td>
                <td>{t.balanceAfter}</td>
                <td className="sub">
                  {t.refType}:{t.refId.slice(0, 22)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
