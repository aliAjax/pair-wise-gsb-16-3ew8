/**
 * 验配记录聚合。
 *
 * 断网复诊场景下的核心规则：
 * 1. 每次回连提交按全局修订序号 seq 排序合并（乐观序号，不是最后写入获胜）；
 * 2. 同一字段出现两个听力师的不同取值 → 冲突，所有取值都留作候选待主管确认；
 * 3. 未确认的修订（pending batch 未关闭）绝不覆盖 effective 当前有效结论，
 *    旧结论继续占机/排诊，直到主管裁决放行。
 */

import { AuditLog } from "./audit";
import {
  Candidate,
  cloneValues,
  EffectiveConclusion,
  FIELD_KEYS,
  FieldKey,
  FieldValues,
  PendingBatch,
  PendingField,
  Revision,
  RevisionInput,
} from "./types";

let batchCounter = 0;

export class FittingRecord {
  readonly id: string;
  readonly patientId: string;
  patientName: string;
  /** 全部修订（含已归档），按序号只增保存 */
  private revisions: Revision[] = [];
  /** 按序号快照的字段值，供三方合并取 base（seq 0 = 初值） */
  private snapshots = new Map<number, FieldValues>();
  private pending: PendingBatch | null = null;
  private effective: EffectiveConclusion;
  /** 记录内单调修订序号 */
  private seqTop: number;

  constructor(
    id: string,
    patientId: string,
    patientName: string,
    initial: FieldValues,
    now: number,
    private audit: AuditLog,
    initialSeq = 0,
  ) {
    this.id = id;
    this.patientId = patientId;
    this.patientName = patientName;
    this.effective = { version: 1, seq: initialSeq, values: cloneValues(initial) };
    this.snapshots.set(initialSeq, cloneValues(initial));
    this.seqTop = initialSeq;
  }

  get effectiveSeq(): number {
    return this.effective.seq;
  }

  getEffective(): EffectiveConclusion {
    return {
      ...this.effective,
      values: cloneValues(this.effective.values),
    };
  }

  hasOpenBatch(): boolean {
    return this.pending !== null;
  }

  getPendingBatch(): PendingBatch | null {
    return this.pending ? cloneBatch(this.pending) : null;
  }

  listRevisions(): Revision[] {
    return this.revisions.map((r) => ({
      ...r,
      changes: { ...r.changes },
    }));
  }

  /**
   * 回连提交一次离线修订。
   * 返回合并结果；冲突字段需要主管裁决，effective 在确认前保持不变。
   */
  submitRevision(input: RevisionInput): {
    revision: Revision;
    duplicated: boolean;
  } {
    // 幂等：断网重推同一 clientId 不再占新序号
    const existing = this.revisions.find((r) => r.clientId === input.clientId);
    if (existing) {
      this.audit.append({
        at: input.at,
        type: "revision-duplicate",
        patientId: this.patientId,
        recordId: this.id,
        author: input.author,
        rationale: `重复推送的离线修订按幂等忽略（原序号 ${existing.seq}）`,
        refs: { clientId: input.clientId, seq: existing.seq },
      });
      return { revision: existing, duplicated: true };
    }

    // 上一批冲突尚未裁决：新修订继续进同一批次参与合并
    const batch =
      this.pending ??
      ({
        id: `batch-${++batchCounter}`,
        openedAt: input.at,
        revisionSeqs: [],
        fields: {},
      } satisfies PendingBatch);

    const seq = this.seqTop + 1;
    this.seqTop = seq;
    const mergedFields: FieldKey[] = [];
    const conflictFields: FieldKey[] = [];

    for (const field of FIELD_KEYS) {
      const incoming = input.changes[field];
      if (incoming === undefined) continue;

      const tip = this.effective.values[field];
      const baseSnapshot = this.snapshots.get(input.baseSeq);
      const base = baseSnapshot ? baseSnapshot[field] : tip;

      if (incoming === tip) {
        // 与当前有效结论一致：无实质变更
        mergedFields.push(field);
        continue;
      }

      const existingPending = batch.fields[field];

      if (base === tip && !existingPending) {
        // 串行快进：base 未被别人动过，单方修改可自动合并，但仍要等批次确认才生效
        batch.fields[field] = singleCandidate(field, tip, incoming, input.author, seq);
        mergedFields.push(field);
      } else {
        // base 已变（两人在同一旧值上分叉）或已有候选：三方合并。
        // 候选恒含“当前有效值”（排第 0 位，seq 记为当前 effective.seq），
        // 保证主管可以选择不采纳任何修订、维持旧结论。
        let pendingField = existingPending;
        if (pendingField && !pendingField.candidates.some((c) => c.value === tip)) {
          pendingField = {
            ...pendingField,
            candidates: [
              { value: tip, author: "(保留当前有效结论)", seq: this.effective.seq },
              ...pendingField.candidates,
            ],
          };
        }
        pendingField =
          pendingField ?? singleCandidate(field, tip, tip, "(保留当前有效结论)", this.effective.seq);
        addCandidate(pendingField, incoming, input.author, seq);
        batch.fields[field] = pendingField;
        // 第 0 位是当前有效值；出现与之不同的候选即为冲突，必须裁决
        const rivalCandidates = pendingField.candidates.filter((c) => c.value !== tip);
        if (rivalCandidates.length >= 2) {
          if (!conflictFields.includes(field)) conflictFields.push(field);
        } else {
          mergedFields.push(field);
        }
      }
    }

    const revision: Revision = {
      ...input,
      seq,
      batchId: mergedFields.length === 0 && conflictFields.length === 0 ? null : batch.id,
      mergedFields,
      conflictFields,
      archived: false,
    };

    batch.revisionSeqs.push(seq);
    this.revisions.push(revision);
    // 快照只记录“已生效”状态；未确认候选不得进入快照，
    // 否则后到的离线修订会以别人尚未生效的取值为 base，三方合并就失真了。
    this.snapshots.set(seq, cloneValues(this.effective.values));

    if (!this.pending && (mergedFields.length > 0 || conflictFields.length > 0)) {
      this.pending = batch;
    }

    this.audit.append({
      at: input.at,
      type: conflictFields.length > 0 ? "revision-conflict" : "revision-merged",
      patientId: this.patientId,
      recordId: this.id,
      author: input.author,
      rationale: input.basis,
      refs: {
        seq,
        baseSeq: input.baseSeq,
        batch: batch.id,
        merged: mergedFields.join(","),
        conflicts: conflictFields.join(","),
        clientId: input.clientId,
      },
    });

    return { revision, duplicated: false };
  }

  /** 还存在未裁决冲突字段的批次不能放行 */
  unresolvedConflicts(): FieldKey[] {
    if (!this.pending) return [];
    return Object.values(this.pending.fields)
      .filter((pf): pf is PendingField => !!pf && pf.candidates.length >= 2)
      .filter((pf) => pf.resolvedValue === undefined)
      .map((pf) => pf.field);
  }

  /** 主管对某个冲突字段裁决：选候选序号（-1 表示保留当前有效值） */
  resolveConflict(field: FieldKey, candidateSeq: number, by: string): void {
    const pf = this.pending?.fields[field];
    if (!pf) throw new Error(`字段 ${field} 没有待确认内容`);
    const candidate =
      candidateSeq === -1 ? null : pf.candidates.find((c) => c.seq === candidateSeq);
    if (candidateSeq !== -1 && !candidate) {
      throw new Error(`候选 ${candidateSeq} 不存在`);
    }
    pf.resolvedValue = candidate ? candidate.value : pf.baseValue;
    pf.resolvedBy = by;
  }

  /**
   * 主管确认整批：未确认修订到此才可能覆盖有效结论。
   * 返回新的有效结论；若本批没有实质变化则仅归档，effective 不动。
   */
  confirmBatch(
    by: string,
    now: number,
    rationale: string,
  ): {
    batchId: string;
    newEffective: EffectiveConclusion | null;
    changedFields: FieldKey[];
    revisionSeqs: number[];
  } {
    const batch = this.pending;
    if (!batch) throw new Error("没有待确认的修订批次");
    const unresolved = this.unresolvedConflicts();
    if (unresolved.length > 0) {
      throw new Error(`仍有冲突未裁决：${unresolved.join("、")}，修订不能覆盖有效结论`);
    }

    const nextValues = cloneValues(this.effective.values);
    const changedFields: FieldKey[] = [];
    for (const field of FIELD_KEYS) {
      const pf = batch.fields[field];
      if (!pf) continue;
      const chosen = pf.resolvedValue ?? pf.candidates[pendingChoice(pf)].value;
      if (chosen !== this.effective.values[field]) {
        nextValues[field] = chosen;
        changedFields.push(field);
      }
    }

    const revisionSeqs = [...batch.revisionSeqs];
    const maxSeq = Math.max(...revisionSeqs, this.effective.seq);
    let newEffective: EffectiveConclusion | null = null;

    if (changedFields.length > 0) {
      newEffective = {
        version: this.effective.version + 1,
        seq: maxSeq,
        values: nextValues,
        confirmedBy: by,
        confirmedAt: now,
        rationale,
      };
      this.effective = newEffective;
      this.snapshots.set(maxSeq, cloneValues(nextValues));
    }

    // 旧修订归档而非删除，仍可按 seq/批次追查
    for (const rev of this.revisions) {
      if (rev.batchId === batch.id) rev.archived = true;
    }

    this.audit.append({
      at: now,
      type: "batch-confirmed",
      patientId: this.patientId,
      recordId: this.id,
      author: by,
      rationale,
      refs: {
        batch: batch.id,
        version: this.effective.version,
        seq: maxSeq,
        revisions: revisionSeqs.join(","),
        changed: changedFields.join(","),
      },
    });

    this.pending = null;
    return { batchId: batch.id, newEffective, changedFields, revisionSeqs };
  }
}

function singleCandidate(
  field: FieldKey,
  baseValue: string,
  value: string,
  author: string,
  seq: number,
): PendingField {
  return {
    field,
    baseValue,
    candidates: [{ value, author, seq }],
  };
}

function addCandidate(pf: PendingField, value: string, author: string, seq: number): void {
  if (!pf.candidates.some((c) => c.value === value && c.author === author)) {
    pf.candidates.push({ value, author, seq });
  }
}

/** 无冲突时的默认选择：最后提交的候选（序号最大） */
function pendingChoice(pf: PendingField): number {
  let best = 0;
  for (let i = 1; i < pf.candidates.length; i += 1) {
    if (pf.candidates[i].seq > pf.candidates[best].seq) best = i;
  }
  return best;
}

function cloneBatch(batch: PendingBatch): PendingBatch {
  return {
    ...batch,
    revisionSeqs: [...batch.revisionSeqs],
    fields: Object.fromEntries(
      Object.entries(batch.fields).map(([field, pf]) => [
        field,
        pf
          ? {
              ...pf,
              candidates: pf.candidates.map((c: Candidate) => ({ ...c })),
            }
          : undefined,
      ]),
    ) as PendingBatch["fields"],
  };
}
