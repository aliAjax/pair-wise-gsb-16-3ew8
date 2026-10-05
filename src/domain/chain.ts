import type {
  Appointment,
  ChainEvent,
  CommitBatch,
  ConclusionFields,
  ConclusionVersion,
  DeviceReservation,
  DeviceStock,
  FieldCandidate,
  FittingRecord,
  InventoryTxn,
  MergeState,
  ReservationState,
  Revision,
  StagedField,
  Station,
} from "./types";
import { DomainError, WriteFailureError } from "./errors";
import { Repository, type WorkspaceState } from "./storage";

export interface Actor {
  id: string;
  name: string;
}

export interface ResolutionChoice {
  field: keyof ConclusionFields;
  /** 选某个候选修订的值 */
  pickRevisionId?: string;
  /** 或主管直接裁决的值 */
  overrideValue?: unknown;
  reason: string;
}

export interface ConfirmResult {
  version: number;
  changed: boolean;
  voidedAppointments: Appointment[];
  preparedBatches: CommitBatch[];
  committedBatches: CommitBatch[];
  failedBatch: CommitBatch | null;
}

const CONCLUSION_FIELDS: (keyof ConclusionFields)[] = [
  "aidModel",
  "ear",
  "gain",
  "trialDevice",
  "followUpDays",
  "note",
];

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function addDays(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 验配链应用服务。
 * 它把验配记录（修订）、复诊预约、试听设备台账接成一条可续作的链：
 *  1. 修订按序号合并、冲突全留待确认、未确认不覆盖有效结论；
 *  2. 有效结论变化 → 未执行的预约/预占全部失效并按新结论重算；
 *  3. 容量不足按“可兑现”分批，批次写入失败从完整批次边界恢复；
 *  4. 主管确认、旧修订、变更依据、库存流水全部进入只追加事件流，可追查。
 */
export class ChainService {
  constructor(
    private repo: Repository,
    private now: () => number = () => Date.now(),
  ) {}

  get state(): WorkspaceState {
    return this.repo.state;
  }

  private persist() {
    this.repo.save();
  }

  // ---------- 事件流（只追加） ----------
  private emit(
    recordId: string,
    actor: Actor,
    type: string,
    summary: string,
    payload?: Record<string, unknown>,
    refRevisionIds?: string[],
  ): ChainEvent {
    const seq = this.state.events.length + 1;
    const ev: ChainEvent = {
      id: `ev-${seq}`,
      seq,
      at: this.now(),
      type,
      recordId,
      actor: actor.id,
      summary,
      payload,
      refRevisionIds,
    };
    this.state.events.push(ev);
    return ev;
  }

  private ledger(
    type: InventoryTxn["type"],
    model: string,
    dueDate: string,
    qty: number,
    refType: string,
    refId: string,
    operator: string,
  ): InventoryTxn {
    const seq = this.state.txns.length + 1;
    const stock = this.repo.stockOf(model);
    const used = this.state.reservations.filter(
      (r) => r.model === model && r.dueDate === dueDate && r.state === "held",
    ).length;
    const balanceAfter = stock ? stock.dailyCapacity - used : 0;
    const txn: InventoryTxn = {
      id: `txn-${seq}`,
      seq,
      at: this.now(),
      type,
      model,
      dueDate,
      qty,
      balanceAfter,
      refType,
      refId,
      operator,
    };
    this.state.txns.push(txn);
    return txn;
  }

  // ---------- 工位 / 断网 ----------
  registerStation(id: string, name: string): Station {
    const existing = this.state.stations.find((s) => s.id === id);
    if (existing) return existing;
    const station: Station = { id, name, online: true, queuedRevisionIds: [], outbox: [], knownSeq: 0 };
    this.state.stations.push(station);
    this.persist();
    return station;
  }

  setStationOnline(stationId: string, online: boolean) {
    const station = this.requireStation(stationId);
    station.online = online;
    this.persist();
  }

  // ---------- 验配档案 ----------
  createRecord(patientId: string, patientName: string, initial: ConclusionFields, actor: Actor): FittingRecord {
    const id = `rec-${this.state.records.length + 1}`;
    const t = this.now();
    const record: FittingRecord = {
      id,
      patientId,
      patientName,
      lastSeq: 0,
      revisions: [],
      current: {
        version: 1,
        fields: initial,
        confirmedBy: actor.id,
        confirmedByName: actor.name,
        confirmedAt: t,
        basis: "建档初始结论",
        revisionIds: [],
      },
      versions: [],
      pendingMerge: null,
      createdAt: t,
    };
    this.state.records.push(record);
    this.emit(id, actor, "RECORD_CREATED", `为 ${patientName} 建立验配档案，初始结论 v1`);
    // 建档即按初始结论排首批复诊与设备预占（容量不足同样进等待批次）
    this.recomputeAppointments(record, actor, record.current);
    this.persist();
    return record;
  }

  private requireRecord(recordId: string): FittingRecord {
    const r = this.state.records.find((x) => x.id === recordId);
    if (!r) throw new DomainError("RECORD_NOT_FOUND", `验配记录 ${recordId} 不存在`);
    return r;
  }

  private requireStation(stationId: string): Station {
    const s = this.state.stations.find((x) => x.id === stationId);
    if (!s) throw new DomainError("STATION_NOT_FOUND", `工位 ${stationId} 不存在`);
    return s;
  }

  /**
   * 听力师提交修订。在线直接进记录；断网进工位发件箱，回连后可续作同步。
   * 修订序号按工位已知序号自增——离线并发可能撞号，合并时以 (seq, createdAt, 工位) 排序。
   */
  openRevision(
    recordId: string,
    stationId: string,
    fields: Partial<ConclusionFields>,
    actor: Actor,
  ): Revision {
    const record = this.requireRecord(recordId);
    const station = this.requireStation(stationId);
    const keys = Object.keys(fields) as (keyof ConclusionFields)[];
    if (keys.length === 0) throw new DomainError("REVISION_EMPTY", "修订必须包含至少一个字段");
    for (const k of keys) {
      if (!CONCLUSION_FIELDS.includes(k)) throw new DomainError("UNKNOWN_FIELD", `未知结论字段 ${k}`);
      const v = fields[k];
      if (Array.isArray(v) ? v.some((n) => typeof n !== "number") : v === undefined) {
        throw new DomainError("INVALID_VALUE", `字段 ${k} 的值不合法`);
      }
    }

    const seq = Math.max(record.lastSeq, station.knownSeq) + 1;
    const revision: Revision = {
      id: `rev-${record.id}-${seq}-${station.id}`,
      seq,
      clientId: record.id,
      authorId: actor.id,
      authorName: actor.name,
      baseVersion: record.current.version,
      createdAt: this.now(),
      fields,
      state: "proposed",
    };
    station.knownSeq = seq;

    if (station.online) {
      record.lastSeq = Math.max(record.lastSeq, seq);
      record.revisions.push(revision);
      this.rebuildMerge(record, actor);
      this.emit(
        record.id,
        actor,
        "REVISION_PROPOSED",
        `${actor.name} 提交修订 #${seq}（基于 v${revision.baseVersion}）`,
        { seq, fields },
        [revision.id],
      );
    } else {
      station.outbox.push(revision);
      station.queuedRevisionIds.push(revision.id);
      this.emit(
        record.id,
        actor,
        "REVISION_QUEUED_OFFLINE",
        `${actor.name} 离线修订 #${seq} 暂存于 ${station.name}，回连后同步`,
        { seq, fields, stationId },
        [revision.id],
      );
    }
    this.persist();
    return revision;
  }

  /** 断网恢复：把工位发件箱里的修订按顺序接回验配链并重新合并 */
  syncStation(stationId: string, actor: Actor): Revision[] {
    const station = this.requireStation(stationId);
    if (!station.online) throw new DomainError("STATION_OFFLINE", `${station.name} 仍处于离线，无法同步`);
    if (station.outbox.length === 0) return [];

    const byRecord = new Map<string, Revision[]>();
    for (const rev of station.outbox) {
      const list = byRecord.get(rev.clientId) ?? [];
      list.push(rev);
      byRecord.set(rev.clientId, list);
    }
    const synced: Revision[] = [];
    for (const [recordId, revs] of byRecord) {
      const record = this.requireRecord(recordId);
      // 离线修订保留工位原序号（撞号不改号），合并时按 (seq, 时间, 工位) 排序裁决
      for (const rev of revs) {
        if (record.revisions.some((r) => r.id === rev.id)) continue;
        record.revisions.push(rev);
        record.lastSeq = Math.max(record.lastSeq, rev.seq);
        station.knownSeq = Math.max(station.knownSeq, record.lastSeq);
        synced.push(rev);
      }
      this.rebuildMerge(record, actor);
      this.emit(
        recordId,
        actor,
        "REVISIONS_SYNCED",
        `${station.name} 回连，${revs.length} 条离线修订接回验配链并重新按序号合并`,
        { revisionIds: revs.map((r) => r.id), seq: revs.map((r) => r.seq) },
        revs.map((r) => r.id),
      );
    }
    station.outbox = [];
    station.queuedRevisionIds = [];
    this.persist();
    return synced;
  }

  /**
   * 合并所有待处理修订：
   * 按修订序号排序依次落到字段；同一字段出现不同值时全部保留为候选并标记冲突。
   * 未确认的合并只能挂在 pendingMerge，绝不覆盖 current 有效结论。
   */
  rebuildMerge(record: FittingRecord, actor: Actor): MergeState | null {
    const pending = record.revisions
      .filter((r) => r.state === "proposed")
      .sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt || a.authorId.localeCompare(b.authorId));

    if (pending.length === 0) {
      record.pendingMerge = null;
      return null;
    }

    const staged = new Map<keyof ConclusionFields, StagedField>();
    for (const rev of pending) {
      for (const field of CONCLUSION_FIELDS) {
        if (!(field in rev.fields)) continue;
        const value = rev.fields[field];
        const entry =
          staged.get(field) ??
          ({ field, candidates: [], conflict: false } satisfies StagedField);
        const dup = entry.candidates.find((c) => sameValue(c.value, value));
        if (!dup) {
          const candidate: FieldCandidate = {
            revisionId: rev.id,
            seq: rev.seq,
            authorId: rev.authorId,
            authorName: rev.authorName,
            value,
          };
          entry.candidates.push(candidate);
        }
        entry.conflict = entry.candidates.length > 1;
        staged.set(field, entry);
      }
    }

    const merge: MergeState = {
      id: `merge-${record.id}-${record.current.version + 1}`,
      recordId: record.id,
      revisionIds: pending.map((r) => r.id),
      staged: [...staged.values()],
      hasConflicts: [...staged.values()].some((s) => s.conflict),
      status: "pending",
      mergedAt: this.now(),
    };
    record.pendingMerge = merge;
    this.emit(
      record.id,
      actor,
      "MERGE_STAGED",
      merge.hasConflicts
        ? `修订 #${pending.map((r) => r.seq).join("、#")} 合并完成，存在字段冲突，等待主管确认`
        : `修订 #${pending.map((r) => r.seq).join("、#")} 合并完成，无冲突，等待主管确认`,
      { mergeId: merge.id, conflicts: merge.staged.filter((s) => s.conflict).map((s) => s.field) },
      merge.revisionIds,
    );
    return merge;
  }

  /**
   * 主管确认合并提案：
   *  - 冲突字段必须逐字段裁决（选候选或给覆盖值+理由）；
   *  - 确认后才生成新有效结论版本，未确认期间 current 永不被覆盖；
   *  - 结论字段实际变化时，未执行的复诊预约与设备预占一律失效并重算；
   *  - 旧修订标记 confirmed/superseded，变更依据（merge + 裁决理由）随版本留档。
   */
  confirmMerge(recordId: string, actor: Actor, resolutions: ResolutionChoice[] = []): ConfirmResult {
    const record = this.requireRecord(recordId);
    const merge = record.pendingMerge;
    if (!merge || merge.status !== "pending") {
      throw new DomainError("MERGE_NOT_PENDING", "当前没有待确认的合并提案");
    }

    for (const staged of merge.staged.filter((s) => s.conflict)) {
      const choice = resolutions.find((r) => r.field === staged.field);
      if (!choice) throw new DomainError("CONFLICT_UNRESOLVED", `冲突字段 ${staged.field} 尚未裁决`);
      if (choice.pickRevisionId === undefined && choice.overrideValue === undefined) {
        throw new DomainError("CONFLICT_UNRESOLVED", `冲突字段 ${staged.field} 必须选定取值`);
      }
      if (choice.pickRevisionId && !staged.candidates.some((c) => c.revisionId === choice.pickRevisionId)) {
        throw new DomainError("CONFLICT_UNRESOLVED", `字段 ${staged.field} 选定的候选不存在`);
      }
      if (!choice.reason?.trim()) {
        throw new DomainError("CONFLICT_UNRESOLVED", `冲突字段 ${staged.field} 的裁决必须写明理由`);
      }
    }

    // 计算合并后的字段
    const nextFields: ConclusionFields = { ...record.current.fields };
    for (const staged of merge.staged) {
      if (!staged.conflict) {
        nextFields[staged.field] = staged.candidates[0].value as never;
        continue;
      }
      const choice = resolutions.find((r) => r.field === staged.field)!;
      if (choice.overrideValue !== undefined) {
        nextFields[staged.field] = choice.overrideValue as never;
      } else {
        const picked = staged.candidates.find((c) => c.revisionId === choice.pickRevisionId)!;
        nextFields[staged.field] = picked.value as never;
      }
    }

    const changed = CONCLUSION_FIELDS.some((f) => !sameValue(nextFields[f], record.current.fields[f]));

    const resolutionBasis = resolutions
      .map((r) => `${String(r.field)}: ${r.reason}`)
      .join("；");
    const basis =
      `合并提案 ${merge.id}（修订 ${merge.revisionIds.join(", ")}）经 ${actor.name} 确认` +
      (resolutionBasis ? `；冲突裁决依据：${resolutionBasis}` : "；无冲突");

    let newVersion = record.current;
    if (changed) {
      newVersion = {
        version: record.current.version + 1,
        fields: nextFields,
        confirmedBy: actor.id,
        confirmedByName: actor.name,
        confirmedAt: this.now(),
        basis,
        mergeId: merge.id,
        revisionIds: [...merge.revisionIds],
      };
      record.versions.push(record.current);
      record.current = newVersion;
    }

    // 修订归位：被采用的字段来源为 confirmed，其余候选（被舍弃的旧值）为 superseded，全部保留可查
    const chosenRevisionIds = new Set<string>();
    for (const staged of merge.staged) {
      const chosenValue = nextFields[staged.field];
      for (const c of staged.candidates) {
        if (sameValue(c.value, chosenValue)) chosenRevisionIds.add(c.revisionId);
      }
    }
    for (const rev of record.revisions) {
      if (merge.revisionIds.includes(rev.id)) {
        rev.state = chosenRevisionIds.has(rev.id) ? "confirmed" : "superseded";
      }
    }
    merge.status = "confirmed";

    this.emit(
      record.id,
      actor,
      changed ? "CONCLUSION_CHANGED" : "CONCLUSION_CONFIRMED_NOOP",
      changed
        ? `有效结论升级为 v${newVersion.version}，变更依据已归档`
        : "合并内容与当前结论一致，不产生新版本",
      {
        version: newVersion.version,
        mergeId: merge.id,
        changed,
        basis,
        resolutions: resolutions.map((r) => ({ ...r })),
      },
      merge.revisionIds,
    );

    const result: ConfirmResult = {
      version: newVersion.version,
      changed,
      voidedAppointments: [],
      preparedBatches: [],
      committedBatches: [],
      failedBatch: null,
    };

    if (changed) {
      result.voidedAppointments = this.invalidateDownstream(record, actor, newVersion);
      const recompute = this.recomputeAppointments(record, actor, newVersion);
      result.preparedBatches = recompute.prepared;
      result.committedBatches = recompute.committed;
      result.failedBatch = recompute.failedBatch;
    }

    this.persist();
    return result;
  }

  // ---------- 下游失效：未执行的预约与预占一律作废 ----------
  private invalidateDownstream(record: FittingRecord, actor: Actor, version: ConclusionVersion): Appointment[] {
    const voided: Appointment[] = [];
    for (const appt of this.state.appointments) {
      if (appt.recordId !== record.id) continue;
      if (appt.state !== "executed" && appt.state !== "invalidated") {
        const ev = this.emit(
          record.id,
          actor,
          "APPOINTMENT_INVALIDATED",
          `复诊预约 ${appt.dueDate}（${appt.reason}）依据的 v${appt.sourceVersion} 已失效，作废重算`,
          { appointmentId: appt.id, fromVersion: appt.sourceVersion, toVersion: version.version },
        );
        appt.state = "invalidated";
        appt.refEventId = ev.id;
        voided.push(appt);
      }
    }
    for (const res of this.state.reservations) {
      if (res.recordId !== record.id) continue;
      if (res.state !== "held") continue;
      // 只有“尚未执行”的预占才失效；已到店试听（关联预约 executed）的占用保留
      const linked = this.state.appointments.find((a) => a.id === res.appointmentId);
      if (linked?.state === "executed") continue;
      res.state = "voided";
      res.voidedAt = this.now();
      this.ledger("RELEASE", res.model, res.dueDate, -1, "reservation", res.id, actor.name);
      this.emit(
        record.id,
        actor,
        "RESERVATION_VOIDED",
        `试听设备预占 ${res.dueDate} ${res.model} 随旧结论释放`,
        { reservationId: res.id, model: res.model, dueDate: res.dueDate },
      );
    }
    return voided;
  }

  // ---------- 重算：按可兑现情况分批写入，失败从完整批次恢复 ----------
  private recomputeAppointments(
    record: FittingRecord,
    actor: Actor,
    version: ConclusionVersion,
  ): { prepared: CommitBatch[]; committed: CommitBatch[]; failedBatch: CommitBatch | null } {
    const fields = version.fields;
    if (fields.followUpDays.length === 0 || !fields.trialDevice) {
      this.emit(record.id, actor, "RECOMPUTE_SKIPPED", "新结论无复诊计划或试听机型，无需重排");
      return { prepared: [], committed: [], failedBatch: null };
    }

    const baseDate = new Date(version.confirmedAt).toISOString().slice(0, 10);
    const drafts = fields.followUpDays.map((day, idx) => ({
      id: `appt-${record.id}-v${version.version}-${idx + 1}`,
      dueDate: addDays(baseDate, day),
      reason: `v${version.version} 复诊（第 ${day} 天）`,
      day,
    }));

    const prepared: CommitBatch[] = [];
    const committed: CommitBatch[] = [];
    let failedBatch: CommitBatch | null = null;

    // 按复诊日期切批：一个批次 = 同一天可整体兑现的预约；日期天然有序
    let ordinal = 0;
    for (const draft of drafts) {
      ordinal += 1;
      const appt: Appointment = {
        id: draft.id,
        recordId: record.id,
        patientName: record.patientName,
        dueDate: draft.dueDate,
        reason: draft.reason,
        sourceVersion: version.version,
        state: "waiting",
        deviceModel: fields.trialDevice,
      };
      this.state.appointments.push(appt);

      const reservation: DeviceReservation = {
        id: `rsv-${record.id}-v${version.version}-${ordinal}`,
        recordId: record.id,
        appointmentId: appt.id,
        model: fields.trialDevice,
        dueDate: draft.dueDate,
        // 提交前为 prepared：不占容量，批次回滚时整批丢弃即可
        state: "prepared",
        sourceVersion: version.version,
        createdAt: this.now(),
      };
      this.state.reservations.push(reservation);

      // 容量判断：可兑现才进批次；容量不足保留预约为 waiting（后续批次），不占库存
      if (this.repo.remaining(fields.trialDevice, draft.dueDate) <= 0) {
        reservation.state = "voided";
        this.emit(
          record.id,
          actor,
          "APPOINTMENT_WAITLISTED",
          `${draft.dueDate} ${fields.trialDevice} 容量不足，预约保留待批次重排，不占机`,
          { appointmentId: appt.id, dueDate: draft.dueDate, model: fields.trialDevice },
        );
        continue;
      }

      const batch: CommitBatch = {
        id: `batch-${record.id}-v${version.version}-${ordinal}`,
        recordId: record.id,
        ordinal,
        dueDate: draft.dueDate,
        items: [{ appointmentId: appt.id, reservationId: reservation.id, model: fields.trialDevice }],
        state: "prepared",
      };
      this.state.batches.push(batch);
      prepared.push(batch);

      try {
        this.repo.commitBatch(batch.id, this.now(), actor.name, (input) => {
          this.state.txns.push({
            ...input,
            seq: this.state.txns.length + 1,
            balanceAfter: this.repo.remaining(input.model, input.dueDate),
          });
        });
        batch.state = "committed";
        committed.push(batch);
        this.emit(
          record.id,
          actor,
          "BATCH_COMMITTED",
          `批次 ${ordinal}（${batch.dueDate}）整批写入成功，预约占机`,
          { batchId: batch.id, ordinal, dueDate: batch.dueDate, model: fields.trialDevice },
        );
      } catch (e) {
        if (e instanceof WriteFailureError) {
          batch.state = "rolledback";
          failedBatch = batch;
          // 从完整批次恢复：本批预约回到 waiting、预占标记 voided 不占机；
          // 已成功的前序批次不受影响，后续批次继续尝试可兑现者
          appt.state = "waiting";
          appt.batchId = batch.id;
          reservation.state = "voided";
          reservation.voidedAt = this.now();
          this.emit(
            record.id,
            actor,
            "BATCH_ROLLED_BACK",
            `批次 ${ordinal}（${batch.dueDate}）写入失败，已从完整批次边界回滚，预约保留可重试`,
            {
              batchId: batch.id,
              ordinal,
              dueDate: batch.dueDate,
              lastCommittedBatch: ordinal - 1,
              error: e.message,
            },
          );
        } else {
          throw e;
        }
      }
    }

    return { prepared, committed, failedBatch };
  }

  /** 失败批次重试（容量恢复/台账恢复后）：仍按整批写入，失败再回滚 */
  retryBatch(recordId: string, batchId: string, actor: Actor): boolean {
    const record = this.requireRecord(recordId);
    const batch = this.state.batches.find((b) => b.id === batchId);
    if (!batch) throw new DomainError("BATCH_NOT_FOUND", `批次 ${batchId} 不存在`);
    if (batch.recordId !== record.id) throw new DomainError("BATCH_NOT_FOUND", "批次不属于该验配记录");
    if (batch.state !== "rolledback") throw new DomainError("BATCH_STATE", `批次状态 ${batch.state} 不可重试`);

    for (const item of batch.items) {
      if (this.repo.remaining(item.model, batch.dueDate) <= 0) {
        this.emit(
          record.id,
          actor,
          "BATCH_RETRY_WAIT",
          `批次 ${batch.ordinal} 重试时 ${batch.dueDate} ${item.model} 容量仍不足，继续等待`,
          { batchId },
        );
        return false;
      }
    }

    batch.state = "prepared";
    try {
      this.repo.commitBatch(batch.id, this.now(), actor.name, (input) => {
        this.state.txns.push({
          ...input,
          seq: this.state.txns.length + 1,
          balanceAfter: this.repo.remaining(input.model, input.dueDate),
        });
      });
      batch.state = "committed";
      this.emit(
        record.id,
        actor,
        "BATCH_RETRY_COMMITTED",
        `批次 ${batch.ordinal} 重试成功，从完整批次恢复后续作`,
        { batchId: batch.id, ordinal: batch.ordinal },
      );
      this.persist();
      return true;
    } catch (e) {
      if (e instanceof WriteFailureError) {
        batch.state = "rolledback";
        this.persist();
        return false;
      }
      throw e;
    }
  }

  /** 补库存（入库流水），随后可重试排队批次 */
  inbound(model: string, dailyCapacityAdd: number, actor: Actor): void {
    const stock = this.repo.stockOf(model);
    if (stock) {
      stock.dailyCapacity += dailyCapacityAdd;
    } else {
      this.state.stock.push({ model, dailyCapacity: dailyCapacityAdd } satisfies DeviceStock);
    }
    this.ledger("INBOUND", model, "-", dailyCapacityAdd, "stock", model, actor.name);
    this.emit("-", actor, "STOCK_INBOUND", `${model} 每日容量增加 ${dailyCapacityAdd}`, {
      model,
      dailyCapacityAdd,
    });
    this.persist();
  }

  /**
   * 容量恢复后重排仍在 waiting 的预约：按日期先后，能兑现的重新切批写入，
   * 仍不足的继续保留 waiting。批次写入失败同样整批回滚。
   */
  replanWaiting(recordId: string, actor: Actor): { committed: CommitBatch[]; failedBatch: CommitBatch | null } {
    const record = this.requireRecord(recordId);
    const waiting = this.state.appointments
      .filter((a) => a.recordId === record.id && a.state === "waiting")
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

    const committed: CommitBatch[] = [];
    let failedBatch: CommitBatch | null = null;

    for (const appt of waiting) {
      const model = appt.deviceModel ?? record.current.fields.trialDevice;
      if (this.repo.remaining(model, appt.dueDate) <= 0) continue; // 仍不足，继续等

      const reservation =
        this.state.reservations.find(
          (r) => r.appointmentId === appt.id && r.state !== "fulfilled",
        ) ??
        ({
          id: `rsv-${appt.id}-replanned`,
          recordId: record.id,
          appointmentId: appt.id,
          model,
          dueDate: appt.dueDate,
          state: "prepared",
          sourceVersion: appt.sourceVersion,
          createdAt: this.now(),
        } satisfies DeviceReservation);
      if (!this.state.reservations.includes(reservation)) this.state.reservations.push(reservation);

      const ordinal = this.state.batches.filter((b) => b.recordId === record.id).length + 1;
      const batch: CommitBatch = {
        id: `batch-${record.id}-replan-${ordinal}`,
        recordId: record.id,
        ordinal,
        dueDate: appt.dueDate,
        items: [{ appointmentId: appt.id, reservationId: reservation.id, model }],
        state: "prepared",
      };
      this.state.batches.push(batch);

      try {
        this.repo.commitBatch(batch.id, this.now(), actor.name, (input) => {
          this.state.txns.push({
            ...input,
            seq: this.state.txns.length + 1,
            balanceAfter: this.repo.remaining(input.model, input.dueDate),
          });
        });
        batch.state = "committed";
        committed.push(batch);
        this.emit(
          record.id,
          actor,
          "WAITING_BATCH_COMMITTED",
          `等待批次（${batch.dueDate}）容量恢复后兑现占机`,
          { batchId: batch.id, appointmentId: appt.id, dueDate: batch.dueDate, model },
        );
      } catch (e) {
        if (e instanceof WriteFailureError) {
          batch.state = "rolledback";
          failedBatch = batch;
          appt.state = "waiting";
          reservation.state = "voided";
          this.emit(
            record.id,
            actor,
            "BATCH_ROLLED_BACK",
            `等待批次（${batch.dueDate}）写入失败，整批回滚，预约继续保留`,
            { batchId: batch.id, dueDate: batch.dueDate, error: e.message },
          );
          break;
        }
        throw e;
      }
    }
    this.persist();
    return { committed, failedBatch };
  }

  // ---------- 追查：主管确认后一切可回溯 ----------
  trace(recordId: string) {
    const record = this.requireRecord(recordId);
    const reservationIds = new Set(
      this.state.reservations.filter((r) => r.recordId === recordId).map((r) => r.id),
    );
    const batchIds = new Set(
      this.state.batches.filter((b) => b.recordId === recordId).map((b) => b.id),
    );
    return {
      record,
      versions: [record.current, ...record.versions].sort((a, b) => b.version - a.version),
      revisions: [...record.revisions].sort((a, b) => a.seq - b.seq),
      pendingMerge: record.pendingMerge,
      appointments: this.state.appointments.filter((a) => a.recordId === recordId),
      reservations: this.state.reservations.filter((r) => r.recordId === recordId),
      batches: this.state.batches.filter((b) => b.recordId === recordId),
      txns: this.state.txns.filter(
        (t) =>
          reservationIds.has(t.refId) ||
          batchIds.has(t.refId) ||
          (t.type === "RESERVE" && batchIds.has(t.refId)),
      ),
      events: this.state.events.filter((e) => e.recordId === recordId),
    };
  }

  /** 全量时间线（跨记录，供审计页） */
  auditLog(): ChainEvent[] {
    return [...this.state.events].sort((a, b) => a.seq - b.seq);
  }

  inventoryLedger(): InventoryTxn[] {
    return [...this.state.txns].sort((a, b) => a.seq - b.seq);
  }
}
