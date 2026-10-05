import type {
  Appointment,
  ChainEvent,
  CommitBatch,
  DeviceReservation,
  DeviceStock,
  FittingRecord,
  InventoryTxn,
  Station,
} from "./types";
import { WriteFailureError } from "./errors";

export interface WorkspaceState {
  records: FittingRecord[];
  appointments: Appointment[];
  reservations: DeviceReservation[];
  stock: DeviceStock[];
  txns: InventoryTxn[];
  batches: CommitBatch[];
  events: ChainEvent[];
  stations: Station[];
}

export function emptyState(): WorkspaceState {
  return {
    records: [],
    appointments: [],
    reservations: [],
    stock: [],
    txns: [],
    batches: [],
    events: [],
    stations: [],
  };
}

const STORAGE_KEY = "hxwl-fitting-chain-v1";

/**
 * 仓储层：负责持久化（localStorage，断网可续作）与台账写入。
 * 注意：业务规则不在这里——这里不是“只负责保存的一张表”，
 * 合并/生效/失效重算/分批回滚全部在 ChainService；
 * 仓储只提供原子批次写入能力和故障注入。
 */
export class Repository {
  state: WorkspaceState;

  constructor(initial?: WorkspaceState) {
    this.state = initial ?? emptyState();
  }

  // ---- 持久化：断网工位的修订刷新不丢 ----
  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      /* 测试环境无 localStorage 时仅驻留内存 */
    }
  }

  static load(): Repository {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return new Repository(JSON.parse(raw) as WorkspaceState);
    } catch {
      /* ignore */
    }
    return new Repository();
  }

  reset() {
    this.state = emptyState();
    this.save();
  }

  // ---- 库存读写 ----
  stockOf(model: string): DeviceStock | undefined {
    return this.state.stock.find((s) => s.model === model);
  }

  /** 某日某机型剩余可排容量 */
  remaining(model: string, dueDate: string): number {
    const stock = this.stockOf(model);
    if (!stock) return 0;
    const used = this.state.reservations.filter(
      (r) => r.model === model && r.dueDate === dueDate && r.state === "held",
    ).length;
    return stock.dailyCapacity - used;
  }

  // ---- 整批原子写入 ----
  /** 注入下一次任意批次的写入故障（模拟台账断连） */
  private failBatchId: string | null = null;
  private failNext = false;
  injectWriteFailure(batchId: string) {
    this.failBatchId = batchId;
  }
  injectNextWriteFailure() {
    this.failNext = true;
  }

  /**
   * 提交一个已准备好的批次：占用库存、写流水、预约转已排诊。
   * 任一步失败则整批不落地（本实现故障在写入前注入，天然原子）。
   */
  commitBatch(
    batchId: string,
    now: number,
    operator: string,
    onLedger: (txn: Omit<InventoryTxn, "seq" | "balanceAfter">) => void,
  ): { txns: InventoryTxn[] } {
    const batch = this.state.batches.find((b) => b.id === batchId);
    if (!batch) throw new WriteFailureError(batchId, "批次不存在");
    if (batch.state !== "prepared") throw new WriteFailureError(batchId, `批次状态为 ${batch.state}`);

    // 故障注入点：写入前检查，失败则不产生任何占用（整批恢复到完整批次的边界）
    if (this.failBatchId === batchId || this.failNext) {
      this.failBatchId = null;
      this.failNext = false;
      throw new WriteFailureError(batchId, "试听设备台账网络抖动，写入被拒绝");
    }

    const producedTxns: InventoryTxn[] = [];
    for (const item of batch.items) {
      if (this.remaining(item.model, batch.dueDate) <= 0) {
        throw new WriteFailureError(batchId, `${batch.dueDate} ${item.model} 容量不足`);
      }
    }

    for (const item of batch.items) {
      this.state.reservations
        .filter((r) => r.id === item.reservationId)
        .forEach((r) => {
          r.state = "held";
          r.batchId = batch.id;
        });
      this.state.appointments
        .filter((a) => a.id === item.appointmentId)
        .forEach((a) => {
          a.state = "scheduled";
          a.batchId = batch.id;
          a.deviceModel = item.model;
        });
      const txnInput: Omit<InventoryTxn, "seq" | "balanceAfter"> = {
        id: `txn-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        at: now,
        type: "RESERVE",
        model: item.model,
        dueDate: batch.dueDate,
        qty: 1,
        refType: "batch",
        refId: batch.id,
        operator,
      };
      onLedger(txnInput);
      const created = this.state.txns[this.state.txns.length - 1];
      if (created) producedTxns.push(created);
    }
    batch.state = "committed";
    return { txns: producedTxns };
  }
}
