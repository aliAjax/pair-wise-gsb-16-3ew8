/**
 * 审计日志：只增不改的验配链流水。
 * 旧修订归档、变更依据、库存出入、预约失效/保留都要在这里追得到。
 */

export type AuditType =
  | "record-created"
  | "revision-merged"
  | "revision-conflict"
  | "revision-duplicate"
  | "batch-confirmed"
  | "appointment-invalidated"
  | "appointment-rebooked"
  | "appointment-deferred"
  | "stock-reserved"
  | "stock-released"
  | "stock-movement"
  | "batch-rolled-back";

export interface AuditEntry {
  id: string;
  at: number;
  type: AuditType;
  patientId: string;
  recordId?: string;
  author: string;
  /** 变更依据 / 备注（如复测结论、容量不足原因） */
  rationale?: string;
  refs?: Record<string, string | number>;
}

let counter = 0;

export function nextId(prefix = "evt"): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export class AuditLog {
  private entries: AuditEntry[] = [];
  /** 事务出口：设置后 append 只进暂存，由事务成功时统一 flush，失败丢弃 */
  private sink: ((entry: AuditEntry) => void) | null = null;

  setSink(sink: ((entry: AuditEntry) => void) | null): void {
    this.sink = sink;
  }

  append(entry: Omit<AuditEntry, "id"> & { id?: string }): AuditEntry {
    const full: AuditEntry = { id: entry.id ?? nextId(), ...entry };
    // 只增：id 唯一且不可重写（暂存出口由调用方保证不重复）
    if (!this.sink && this.entries.some((e) => e.id === full.id)) {
      throw new Error(`审计事件 ${full.id} 已存在，审计日志不可重写`);
    }
    if (this.sink) {
      this.sink(full);
      return full;
    }
    this.entries.push(full);
    return full;
  }

  /** 追查：按患者 / 记录 / 类型过滤的时间线 */
  query(filter: {
    patientId?: string;
    recordId?: string;
    type?: AuditType;
  }): AuditEntry[] {
    return this.entries.filter(
      (e) =>
        (!filter.patientId || e.patientId === filter.patientId) &&
        (!filter.recordId || e.recordId === filter.recordId) &&
        (!filter.type || e.type === filter.type),
    );
  }

  all(): readonly AuditEntry[] {
    return this.entries;
  }

  /** 事务成功后把暂存事件一次性入账 */
  flush(buffered: AuditEntry[]): void {
    for (const entry of buffered) {
      if (this.entries.some((e) => e.id === entry.id)) {
        throw new Error(`审计事件 ${entry.id} 已存在，审计日志不可重写`);
      }
      this.entries.push(entry);
    }
  }

  snapshot(): AuditEntry[] {
    return this.entries.map((e) => ({ ...e, refs: e.refs ? { ...e.refs } : undefined }));
  }
}
