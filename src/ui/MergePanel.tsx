import { useState } from "react";
import type { ChainService, Actor, ResolutionChoice } from "../domain/chain";
import type { ConclusionFields } from "../domain/types";
import { REVISION_LABEL } from "./labels";

interface Props {
  service: ChainService;
  recordId: string;
  supervisor: Actor;
  onDone: (msg?: string) => void;
}

function displayValue(v: unknown): string {
  return Array.isArray(v) ? `第 ${v.join("、")} 天` : String(v);
}

/** 主管确认台：冲突候选全保留、逐字段裁决并写明依据，确认后结论才生效 */
export function MergePanel({ service, recordId, supervisor, onDone }: Props) {
  const record = service.state.records.find((r) => r.id === recordId)!;
  const merge = record.pendingMerge;
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  if (!merge) {
    return (
      <div className="subpanel">
        <div className="subpanel-head">
          <strong>主管确认台</strong>
        </div>
        <p className="hint">当前没有待确认的合并提案。两位听力师的修订回连接入后，会在这里按修订序号集中呈现。</p>
      </div>
    );
  }

  const confirm = () => {
    const resolutions: ResolutionChoice[] = merge.staged
      .filter((s) => s.conflict)
      .map((s) => ({
        field: s.field as keyof ConclusionFields,
        pickRevisionId: picks[s.field] ?? s.candidates[0].revisionId,
        reason: reasons[s.field] ?? "",
      }));
    try {
      const result = service.confirmMerge(recordId, supervisor, resolutions);
      setError("");
      if (!result.changed) {
        onDone("已确认：合并内容与当前有效结论一致，不产生新版本");
      } else {
        const parts = [
          `有效结论升级为 v${result.version}`,
          `失效重算：${result.voidedAppointments.length} 条旧预约作废`,
          `批次兑现 ${result.committedBatches.length} 个${result.failedBatch ? "，1 个批次写入失败已整批回滚" : ""}`,
        ];
        onDone(parts.join("；"));
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="subpanel">
      <div className="subpanel-head">
        <strong>主管确认台</strong>
        <span className={`pill ${merge.hasConflicts ? "danger" : "ok"}`}>
          {merge.hasConflicts ? "存在冲突·待裁决" : "无冲突·可直接确认"}
        </span>
      </div>
      <p className="hint">
        合并自 {merge.revisionIds.length} 条修订（{merge.revisionIds.map((id) => record.revisions.find((r) => r.id === id)?.seq).join("、")} 号）。
        当前有效结论 <b>v{record.current.version}</b> 在确认前不会被覆盖。
      </p>

      <div className="merge-list">
        {merge.staged.map((s) => (
          <div key={s.field} className={`merge-field ${s.conflict ? "conflict" : ""}`}>
            <div className="merge-field-head">
              <span className="field-name">{fieldLabel(s.field)}</span>
              {s.conflict ? <span className="tag danger">冲突 {s.candidates.length} 选 1</span> : <span className="tag ok">一致</span>}
            </div>
            <div className="current-line">
              现行 v{record.current.version}：<code>{displayValue(record.current.fields[s.field])}</code>
            </div>
            {s.candidates.map((c) => (
              <label key={c.revisionId} className="candidate">
                <input
                  type="radio"
                  name={s.field}
                  checked={(picks[s.field] ?? (s.conflict ? "" : c.revisionId)) === c.revisionId}
                  disabled={!s.conflict}
                  onChange={() => setPicks((p) => ({ ...p, [s.field]: c.revisionId }))}
                />
                <span>
                  <code>{displayValue(c.value)}</code>
                  <small>
                    #{c.seq} {c.authorName} ·{" "}
                    {REVISION_LABEL[record.revisions.find((r) => r.id === c.revisionId)?.state ?? "proposed"]}
                  </small>
                </span>
              </label>
            ))}
            {s.conflict && (
              <input
                className="reason"
                placeholder="裁决依据（必填，随版本归档可追查）"
                value={reasons[s.field] ?? ""}
                onChange={(e) => setReasons((r) => ({ ...r, [s.field]: e.target.value }))}
              />
            )}
          </div>
        ))}
      </div>

      {error && <p className="error">{error}</p>}
      <button className="mini primary" onClick={confirm}>
        主管确认并让结论生效
      </button>
    </div>
  );
}

export function fieldLabel(f: string): string {
  return (
    {
      aidModel: "建议机型",
      ear: "验配耳别",
      gain: "增益/程序",
      trialDevice: "试听机型",
      followUpDays: "复诊计划",
      note: "备注",
    } as Record<string, string>
  )[f] ?? f;
}
