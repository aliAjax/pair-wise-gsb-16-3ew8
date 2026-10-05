/**
 * 可续作的验配链：把验配记录、复诊预约、试听设备台账接成一条会联动的链，
 * 而不是各自独立保存的三张表。
 *
 * 主管确认一个修订批次后，链路自动执行：
 *   有效结论换版
 *     → 未执行的复诊预约 / 试听预占全部失效并释放设备（旧结论不再占机排诊）
 *     → 依据新结论重建复诊请求，按容量重算，可兑现者组成一个完整批次
 *     → 整批原子落库；任何写入失败按提交前快照恢复，之后可重试
 * 旧修订（归档而非删除）、变更依据、库存流水全部进同一条审计时间线。
 */

import { AuditEntry, AuditLog } from "./audit";
import { DeviceLedger } from "./deviceLedger";
import { FittingRecord } from "./fittingRecord";
import { FollowUpRequest, FollowUpScheduler, PlannedBatch } from "./scheduler";
import { FieldKey, FieldValues, RevisionInput } from "./types";

export interface FollowUpSpec {
  preferredDate: string;
  priority: number;
}

export interface ConfirmResult {
  batchId: string;
  version: number;
  changedFields: FieldKey[];
  invalidated: string[];
  planned: PlannedBatch;
  committed: boolean;
  appointmentIds: string[];
  error?: string;
}

export class FittingChain {
  readonly audit = new AuditLog();
  readonly ledger = new DeviceLedger(this.audit);
  readonly scheduler = new FollowUpScheduler(this.ledger, this.audit);
  private records = new Map<string, FittingRecord>();
  private followUps = new Map<string, FollowUpSpec>();

  createRecord(input: {
    id: string;
    patientId: string;
    patientName: string;
    initial: FieldValues;
    at: number;
  }): FittingRecord {
    const record = new FittingRecord(
      input.id,
      input.patientId,
      input.patientName,
      input.initial,
      input.at,
      this.audit,
    );
    this.records.set(input.id, record);
    this.audit.append({
      at: input.at,
      type: "record-created",
      patientId: input.patientId,
      recordId: input.id,
      author: "system",
      rationale: "建立验配档案与初版有效结论 v1",
    });
    return record;
  }

  getRecord(id: string): FittingRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`验配记录 ${id} 不存在`);
    return record;
  }

  /** 听力师断网复诊修订（回连时调用） */
  revise(recordId: string, input: RevisionInput) {
    return this.getRecord(recordId).submitRevision(input);
  }

  resolveConflict(recordId: string, field: FieldKey, candidateSeq: number, by: string) {
    this.getRecord(recordId).resolveConflict(field, candidateSeq, by);
  }

  /**
   * 主管确认 + 链路重算。
   * failAtAssignment 用于演示“写入失败 → 完整批次回滚”。
   */
  confirm(
    recordId: string,
    by: string,
    at: number,
    rationale: string,
    options: { failAtAssignment?: number } = {},
  ): ConfirmResult {
    const record = this.getRecord(recordId);
    const result = record.confirmBatch(by, at, rationale);

    if (!result.newEffective) {
      // 没有实质变化：不折腾下游，旧预约与预占继续有效
      return {
        batchId: result.batchId,
        version: record.getEffective().version,
        changedFields: [],
        invalidated: [],
        planned: { id: `${result.batchId}-noop`, assignments: [], deferred: [] },
        committed: true,
        appointmentIds: [],
      };
    }

    // 1) 旧结论派生的未执行预约与设备预占失效释放
    const invalidated = this.scheduler.invalidateForPatient(
      record.patientId,
      at,
      result.newEffective.version,
      rationale,
    );

    // 2) 依据新结论重建复诊请求（型号取自新有效结论；日期/优先级沿用档案设置）
    const spec = this.followUps.get(recordId);
    if (spec) {
      const request: FollowUpRequest = {
        id: `fr-${recordId}-v${result.newEffective.version}`,
        patientId: record.patientId,
        recordId,
        preferredDate: spec.preferredDate,
        requiredModel: result.newEffective.values.deviceModel,
        priority: spec.priority,
        bookedAt: at,
      };
      this.scheduler.upsertRequest(request);
    }

    // 3) 按当前容量重算，可兑现者组成完整批次，容量不足者顺延
    const openIds = this.scheduler.deferredRequestIds(recordId);
    if (spec) openIds.push(`fr-${recordId}-v${result.newEffective.version}`);
    const planned = this.scheduler.plan([...new Set(openIds)]);

    // 4) 整批原子提交；失败已在 scheduler 内从快照恢复，调用方可原样重试
    let committed = true;
    let appointmentIds: string[] = [];
    let error: string | undefined;
    try {
      const commitResult = this.scheduler.commit(
        planned,
        at,
        { failAtAssignment: options.failAtAssignment },
        record.patientId,
      );
      appointmentIds = commitResult.appointments.map((a) => a.id);
    } catch (err) {
      committed = false;
      error = err instanceof Error ? err.message : String(err);
    }

    return {
      batchId: result.batchId,
      version: result.newEffective.version,
      changedFields: result.changedFields,
      invalidated: invalidated.map((a) => a.id),
      planned,
      committed,
      appointmentIds,
      error,
    };
  }

  /** 容量恢复后对顺延请求重试（仍走 plan → 原子 commit） */
  retryDeferred(recordId: string, at: number): ConfirmResult | null {
    const record = this.getRecord(recordId);
    const deferred = this.scheduler.deferredRequestIds(recordId);
    if (deferred.length === 0) return null;
    const planned = this.scheduler.plan(deferred);
    const commitResult = this.scheduler.commit(planned, at, undefined, record.patientId);
    return {
      batchId: planned.id,
      version: this.getRecord(recordId).getEffective().version,
      changedFields: [],
      invalidated: [],
      planned,
      committed: true,
      appointmentIds: commitResult.appointments.map((a) => a.id),
    };
  }

  setFollowUpSpec(recordId: string, spec: FollowUpSpec): void {
    this.followUps.set(recordId, spec);
  }

  /** 追查：某患者的完整链路时间线（修订/确认/预约/库存） */
  timeline(patientId: string): AuditEntry[] {
    return this.audit.query({ patientId });
  }

  /** 追查：全部库存流水（含 release / reserve） */
  stockMovements(model?: string) {
    return this.ledger.listMovements(model ? { model } : undefined);
  }
}
