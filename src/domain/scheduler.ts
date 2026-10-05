/**
 * 复诊调度。
 *
 * 与验配记录联动的规则：
 * - 有效结论变化 → 该患者所有“待执行”的复诊预约与试听设备预占整体失效（释放设备、留审计），
 *   然后依据新结论重新排队重算；
 * - 设备/诊位容量不足时，按优先级把“可兑现”的预约保留成一个完整批次，其余顺延，
 *   不接受半批次写入；
 * - 批次提交走快照事务：任何一步写入失败 → 回滚到提交前的完整批次状态。
 */

import { AuditEntry, AuditLog } from "./audit";
import { DeviceLedger } from "./deviceLedger";

export type AppointmentStatus = "scheduled" | "invalidated" | "deferred";

export interface FollowUpRequest {
  id: string;
  patientId: string;
  recordId: string;
  preferredDate: string;
  /** 新结论要求试听的型号 */
  requiredModel: string;
  /** 数值越大越优先（如老人/儿童优先） */
  priority: number;
  bookedAt: number;
}

export interface Appointment {
  id: string;
  requestId: string;
  patientId: string;
  recordId: string;
  date: string;
  model: string;
  status: AppointmentStatus;
  /** 失效时记录原因（结论版本变化），便于追查“为什么旧结论不再占机排诊” */
  invalidatedReason?: string;
  reservedRef?: string;
}

export interface BatchAssignment {
  request: FollowUpRequest;
  date: string;
}

export interface PlannedBatch {
  id: string;
  assignments: BatchAssignment[];
  deferred: FollowUpRequest[];
}

export interface CommitFailure {
  /** 注入用：在处理到第几个预约时让写入失败（0 基） */
  failAtAssignment?: number;
}

const DEFAULT_DAILY_SLOTS = 4;

let appointmentCounter = 0;
let batchCounter = 0;

export class FollowUpScheduler {
  private appointments: Appointment[] = [];
  private requests: FollowUpRequest[] = [];
  private deferredQueue: FollowUpRequest[] = [];
  private slotCapacity: Record<string, number> = {};

  constructor(
    private ledger: DeviceLedger,
    private audit: AuditLog,
  ) {}

  setDailySlots(date: string, slots: number): void {
    this.slotCapacity[date] = slots;
  }

  upsertRequest(request: FollowUpRequest): void {
    const idx = this.requests.findIndex((r) => r.id === request.id);
    if (idx >= 0) this.requests[idx] = request;
    else this.requests.push(request);
  }

  listAppointments(status?: AppointmentStatus): Appointment[] {
    return this.appointments
      .filter((a) => !status || a.status === status)
      .map((a) => ({ ...a }));
  }

  scheduledCount(date: string): number {
    return this.appointments.filter((a) => a.status === "scheduled" && a.date === date).length;
  }

  /** 容量不足被顺延、等待容量释放后重算的请求 */
  deferredRequestIds(recordId?: string): string[] {
    return this.deferredQueue
      .filter((r) => !recordId || r.recordId === recordId)
      .map((r) => r.id);
  }

  private slotsFor(date: string): number {
    return this.slotCapacity[date] ?? DEFAULT_DAILY_SLOTS;
  }

  /**
   * 有效结论变化：该患者待执行预约与设备预占全部失效。
   * 旧结论自此不再占机、不再排诊；释放动作全部留痕。
   */
  invalidateForPatient(
    patientId: string,
    at: number,
    newVersion: number,
    reason: string,
  ): Appointment[] {
    const invalidated: Appointment[] = [];
    for (const appt of this.appointments) {
      if (appt.patientId !== patientId || appt.status !== "scheduled") continue;
      appt.status = "invalidated";
      appt.invalidatedReason = reason;
      this.ledger.release(appt.model, appt.date, 1, at, appt.reservedRef ?? appt.id, patientId);
      this.audit.append({
        at,
        type: "appointment-invalidated",
        patientId,
        recordId: appt.recordId,
        author: "scheduler",
        rationale: `有效结论变为 v${newVersion}，旧预约 ${appt.id} 失效重算：${reason}`,
        refs: { appointment: appt.id, date: appt.date, model: appt.model },
      });
      invalidated.push({ ...appt });
    }
    return invalidated;
  }

  /**
   * 按当前容量排一批：优先级高、且诊位与试听设备都能兑现的请求进批次，
   * 其余顺延。批次是“保留预约”的最小提交单位。
   */
  plan(openRequestIds: string[]): PlannedBatch {
    const open = this.requests
      .filter((r) => openRequestIds.includes(r.id))
      .sort((a, b) =>
        b.priority - a.priority ||
        a.preferredDate.localeCompare(b.preferredDate) ||
        a.bookedAt - b.bookedAt,
      );

    const assignments: BatchAssignment[] = [];
    const deferred: FollowUpRequest[] = [];
    // 计划内的临时占用，保证同批次内两个请求不会重复算到同一台设备/同一个诊位
    const deviceUsed = new Map<string, number>();
    const slotUsed = new Map<string, number>();

    for (const request of open) {
      const date = request.preferredDate;
      const deviceKey = `${request.requiredModel}|${date}`;
      const deviceLeft =
        this.ledger.capacityFor(request.requiredModel, date) - (deviceUsed.get(deviceKey) ?? 0);
      const slotLeft = this.slotsFor(date) - this.scheduledCount(date) - (slotUsed.get(date) ?? 0);

      if (deviceLeft >= 1 && slotLeft >= 1) {
        assignments.push({ request, date });
        deviceUsed.set(deviceKey, (deviceUsed.get(deviceKey) ?? 0) + 1);
        slotUsed.set(date, (slotUsed.get(date) ?? 0) + 1);
      } else {
        deferred.push(request);
      }
    }

    return { id: `plan-${++batchCounter}`, assignments, deferred: [...deferred] };
  }

  /**
   * 原子提交整批：先快照，逐台预占 + 落预约；任一步失败则恢复快照，
   * 保证不会出现“设备预占了但预约没排上”的半批次。
   */
  commit(
    batch: PlannedBatch,
    at: number,
    failure?: CommitFailure,
    patientId = "-",
  ): { appointments: Appointment[]; rolledBack: boolean } {
    const snap = this.ledger.snapshot();
    // 事务期审计暂存：成功才入账，回滚后不会残留“预占成功”的假流水
    const buffered: AuditEntry[] = [];
    this.audit.setSink((e) => buffered.push(e));
    const created: Appointment[] = [];
    try {
      batch.assignments.forEach((assignment, index) => {
        if (failure?.failAtAssignment === index) {
          throw new Error(`第 ${index + 1} 条预约写入失败（模拟设备台账拒绝）`);
        }
        const { request, date } = assignment;
        appointmentCounter += 1;
        const reservedRef = `rsv-${request.id}`;
        const appt: Appointment = {
          id: `apt-${appointmentCounter}`,
          requestId: request.id,
          patientId: request.patientId,
          recordId: request.recordId,
          date,
          model: request.requiredModel,
          status: "scheduled",
          reservedRef,
        };
        this.ledger.reserve(request.requiredModel, date, 1, at, reservedRef, request.patientId);
        this.appointments.push(appt);
        created.push(appt);
        this.audit.append({
          at,
          type: "appointment-rebooked",
          patientId: request.patientId,
          recordId: request.recordId,
          author: "scheduler",
          rationale: `按新结论重排，批次 ${batch.id}`,
          refs: { appointment: appt.id, date, model: request.requiredModel, batch: batch.id },
        });
      });

      for (const request of batch.deferred) {
        this.audit.append({
          at,
          type: "appointment-deferred",
          patientId: request.patientId,
          recordId: request.recordId,
          author: "scheduler",
          rationale: `设备或诊位容量不足，顺延待容量释放后重算`,
          refs: { request: request.id, date: request.preferredDate, model: request.requiredModel },
        });
      }

      this.audit.setSink(null);
      this.audit.flush(buffered);

      // 更新顺延队列：本批兑现的移出，容量不足的留下
      const assignedIds = new Set(batch.assignments.map((a) => a.request.id));
      this.deferredQueue = [
        ...this.deferredQueue.filter((r) => !assignedIds.has(r.id)),
        ...batch.deferred.filter(
          (r) => !this.deferredQueue.some((q) => q.id === r.id),
        ),
      ];

      return { appointments: created.map((a) => ({ ...a })), rolledBack: false };
    } catch (err) {
      // 从完整批次快照恢复：库存、预占、已落预约全部回到提交前
      this.audit.setSink(null);
      this.ledger.restore(snap);
      for (const appt of created) {
        const idx = this.appointments.lastIndexOf(appt);
        if (idx >= 0) this.appointments.splice(idx, 1);
      }
      // 没写成的请求回到顺延队列，等待容量恢复后整批重试
      const failedIds = new Set(batch.assignments.map((a) => a.request.id));
      for (const request of batch.assignments.map((a) => a.request)) {
        if (!this.deferredQueue.some((q) => q.id === request.id)) {
          this.deferredQueue.push(request);
        }
      }
      this.audit.append({
        at,
        type: "batch-rolled-back",
        patientId,
        author: "scheduler",
        rationale: err instanceof Error ? err.message : String(err),
        refs: { batch: batch.id, attempted: batch.assignments.length, failed: [...failedIds].join(",") },
      });
      throw err;
    }
  }
}
