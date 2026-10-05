import type { ChainService, Actor } from "../domain/chain";
import { APPOINTMENT_LABEL, BATCH_LABEL, RESERVATION_LABEL } from "./labels";

interface Props {
  service: ChainService;
  recordId: string;
  supervisor: Actor;
  onDone: (msg?: string) => void;
}

/** 下游链：复诊预约 + 试听设备预占 + 批次；支持故障注入/整批重试/入库重排 */
export function DownstreamPanel({ service, recordId, supervisor, onDone }: Props) {
  const appointments = service.state.appointments.filter((a) => a.recordId === recordId);
  const reservations = service.state.reservations.filter((r) => r.recordId === recordId);
  const batches = service.state.batches.filter((b) => b.recordId === recordId);

  const injectFailure = () => {
    (service as unknown as { repo: { injectNextWriteFailure: () => void } }).repo.injectNextWriteFailure();
    onDone("已注入：下一次台账批次写入将失败，观察整批回滚");
  };

  return (
    <div className="subpanel">
      <div className="subpanel-head">
        <strong>复诊预约 × 试听设备台账</strong>
        <span className="hint">有效结论一变，未执行项即失效重算</span>
      </div>

      <div className="row wrap">
        <button className="mini warn" onClick={injectFailure}>
          注入台账写入故障
        </button>
        <button
          className="mini"
          onClick={() => {
            const r = service.replanWaiting(recordId, supervisor);
            onDone(
              r.committed.length > 0
                ? `重排兑现 ${r.committed.length} 个等待批次${r.failedBatch ? "，另有批次失败已回滚" : ""}`
                : "暂无可兑现的等待批次（容量仍不足或台账故障）",
            );
          }}
        >
          重排等待批次
        </button>
        {waitingModel(service, recordId) && (
          <button
            className="mini"
            onClick={() => {
              const model = waitingModel(service, recordId)!;
              service.inbound(model, 1, supervisor);
              onDone(`${model} 入库 +1 日容量（已写 INBOUND 流水），可再点“重排等待批次”`);
            }}
          >
            试听机入库 +1/日
          </button>
        )}
      </div>

      <table className="grid">
        <thead>
          <tr>
            <th>复诊日期</th>
            <th>事项 / 依据版本</th>
            <th>预约状态</th>
            <th>设备批次</th>
          </tr>
        </thead>
        <tbody>
          {appointments.map((a) => {
            const rsv = reservations.find((r) => r.appointmentId === a.id);
            const batch = batches.find((b) => b.items.some((i) => i.appointmentId === a.id));
            return (
              <tr key={a.id} className={`state-${a.state}`}>
                <td>{a.dueDate}</td>
                <td>
                  {a.reason}
                  <div className="sub">v{a.sourceVersion}</div>
                </td>
                <td>
                  <span className={`state-pill ${a.state}`}>{APPOINTMENT_LABEL[a.state]}</span>
                </td>
                <td>
                  {batch ? (
                    <span className={`state-pill batch-${batch.state}`}>
                      批次{batch.ordinal} · {BATCH_LABEL[batch.state]}
                      {batch.state === "rolledback" && (
                        <button
                          className="link-btn"
                          onClick={() => {
                            const ok = service.retryBatch(recordId, batch.id, supervisor);
                            onDone(ok ? "批次重试成功，已从完整批次恢复" : "批次重试失败，仍回滚等待");
                          }}
                        >
                          重试
                        </button>
                      )}
                    </span>
                  ) : rsv ? (
                    <span className={`state-pill rsv-${rsv.state}`}>{RESERVATION_LABEL[rsv.state]}</span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="hint">
        容量不足时预约保留为“等待批次”，不占机、不让旧结论继续排诊；写入失败只回滚当前完整批次，前序已兑现批次不受影响。
      </p>
    </div>
  );
}

function waitingModel(service: ChainService, recordId: string): string | null {
  const waiting = service.state.appointments.find(
    (a) => a.recordId === recordId && a.state === "waiting",
  );
  return waiting?.deviceModel ?? null;
}
