import { useState } from "react";
import type { ChainService } from "../domain/chain";
import type { Actor } from "../domain/chain";
import type { ConclusionFields } from "../domain/types";

interface Props {
  service: ChainService;
  recordId: string;
  actor: Actor;
  actorRole: "audiologist1" | "audiologist2" | "supervisor";
  onDone: () => void;
}

const MODEL_OPTIONS = ["聆声 S1 试听机", "聆声 Pro2 试听机"];
const FOLLOWUP_PRESETS: Record<string, number[]> = {
  "一周复诊": [7],
  "两周复诊": [14],
  "双次复诊": [7, 14],
};

/** 听力师离线/在线修订面板：只产生修订，永不直接改有效结论 */
export function RevisionPanel({ service, recordId, actor, actorRole, onDone }: Props) {
  const stationId = actorRole === "audiologist2" ? "station-B" : "station-A";
  const station = service.state.stations.find((s) => s.id === stationId)!;
  const record = service.state.records.find((r) => r.id === recordId)!;
  const [gain, setGain] = useState("");
  const [trialDevice, setTrialDevice] = useState("");
  const [followup, setFollowup] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const submit = () => {
    const fields: Partial<ConclusionFields> = {};
    if (gain.trim()) fields.gain = gain.trim();
    if (trialDevice) fields.trialDevice = trialDevice;
    if (followup) fields.followUpDays = FOLLOWUP_PRESETS[followup];
    if (note.trim()) fields.note = note.trim();
    if (Object.keys(fields).length === 0) {
      setError("至少修订一个字段");
      return;
    }
    try {
      service.openRevision(recordId, stationId, fields, actor);
      setGain("");
      setTrialDevice("");
      setFollowup("");
      setNote("");
      setError("");
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="subpanel">
      <div className="subpanel-head">
        <strong>{actor.name} 的修订台</strong>
        <span className={`pill ${station.online ? "ok" : "off"}`}>
          {station.online ? "在线·直连验配链" : "断网·本地发件箱续作"}
        </span>
      </div>
      <div className="row">
        <button
          className="mini"
          onClick={() => {
            service.setStationOnline(stationId, !station.online);
            onDone();
          }}
        >
          {station.online ? "模拟断网" : "模拟回连"}
        </button>
        {!station.online && (
          <button
            className="mini primary"
            disabled={station.outbox.length === 0}
            onClick={() => {
              service.syncStation(stationId, actor);
              onDone();
            }}
          >
            回连同步（发件箱 {station.outbox.length} 条）
          </button>
        )}
      </div>

      <div className="form-grid">
        <label>
          <span>增益/程序</span>
          <input value={gain} onChange={(e) => setGain(e.target.value)} placeholder="如：程序C / 降噪优先" />
        </label>
        <label>
          <span>试听机型</span>
          <select value={trialDevice} onChange={(e) => setTrialDevice(e.target.value)}>
            <option value="">不修改</option>
            {MODEL_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>复诊计划</span>
          <select value={followup} onChange={(e) => setFollowup(e.target.value)}>
            <option value="">不修改</option>
            {Object.keys(FOLLOWUP_PRESETS).map((k) => (
              <option key={k} value={k}>
                {k}（第 {FOLLOWUP_PRESETS[k].join("/")} 天）
              </option>
            ))}
          </select>
        </label>
        <label className="wide">
          <span>修订说明</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="复测依据/用户反馈" />
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      <button className="mini primary" onClick={submit}>
        提交修订 #{Math.max(station.knownSeq, record.lastSeq) + 1}
      </button>
      <p className="hint">
        修订只进“待确认合并”，{station.online ? "" : "断网时进工位发件箱，回连后"}按修订序号并入，绝不直接覆盖当前有效结论。
      </p>
    </div>
  );
}
