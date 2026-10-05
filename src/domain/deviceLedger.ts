/**
 * 试听设备台账。
 * - 库存只通过流水变动（入库/出库/预占/释放），流水只增不改，主管可追查；
 * - 容量按“型号 + 日期”计算：当日可用 = 现有库存 - 当日已预占；
 * - 有效结论变化导致的预占释放也留流水，不做静默删除。
 */

import { AuditLog } from "./audit";

export type MovementType = "inbound" | "outbound" | "reserve" | "release";

export interface StockMovement {
  id: string;
  at: number;
  model: string;
  date: string;
  type: MovementType;
  qty: number;
  reason: string;
  ref?: string;
}

export interface DeviceLedgerState {
  /** 各型号现有可调配台数 */
  onHand: Record<string, number>;
}

let moveCounter = 0;

export class DeviceLedger {
  private onHand: Record<string, number> = {};
  private movements: StockMovement[] = [];
  /** model|date -> 占用数 */
  private reservations = new Map<string, number>();

  constructor(private audit: AuditLog) {}

  inbound(model: string, qty: number, at: number, reason: string): StockMovement {
    if (qty <= 0) throw new Error("入库数量必须为正");
    this.onHand[model] = (this.onHand[model] ?? 0) + qty;
    return this.record(at, model, "", "inbound", qty, reason);
  }

  outbound(model: string, qty: number, at: number, reason: string): StockMovement {
    if ((this.onHand[model] ?? 0) < qty) throw new Error(`${model} 库存不足，无法出库`);
    this.onHand[model] -= qty;
    return this.record(at, model, "", "outbound", qty, reason);
  }

  capacityFor(model: string, date: string): number {
    return Math.max(0, (this.onHand[model] ?? 0) - this.reserved(model, date));
  }

  reserved(model: string, date: string): number {
    return this.reservations.get(`${model}|${date}`) ?? 0;
  }

  getOnHand(model: string): number {
    return this.onHand[model] ?? 0;
  }

  reserve(model: string, date: string, qty: number, at: number, ref: string, patientId: string): void {
    if (this.capacityFor(model, date) < qty) {
      throw new Error(`${model} 在 ${date} 容量不足`);
    }
    this.reservations.set(`${model}|${date}`, this.reserved(model, date) + qty);
    this.record(at, model, date, "reserve", qty, `试听设备预占 ${ref}`, ref, patientId);
  }

  /** 有效结论变化后旧预占失效：释放并留流水 */
  release(model: string, date: string, qty: number, at: number, ref: string, patientId: string): void {
    const current = this.reserved(model, date);
    if (qty > current) throw new Error(`${model} 在 ${date} 没有可释放的预占`);
    this.reservations.set(`${model}|${date}`, current - qty);
    this.record(at, model, date, "release", qty, `结论变化，旧预占失效 ${ref}`, ref, patientId);
  }
  listMovements(filter?: { model?: string; date?: string }): StockMovement[] {
    return this.movements
      .filter(
        (m) =>
          (!filter?.model || m.model === filter.model) &&
          (!filter?.date || m.date === filter.date),
      )
      .map((m) => ({ ...m }));
  }

  snapshot(): DeviceLedgerState & { reservations: Record<string, number>; movements: StockMovement[] } {
    return {
      onHand: { ...this.onHand },
      reservations: Object.fromEntries(this.reservations),
      movements: this.movements.map((m) => ({ ...m })),
    };
  }

  restore(snap: ReturnType<DeviceLedger["snapshot"]>): void {
    this.onHand = { ...snap.onHand };
    this.reservations = new Map(Object.entries(snap.reservations));
    // 回滚不追加流水；已记录的失败事件本身留在审计中，库存状态回到提交前
    this.movements = snap.movements.map((m) => ({ ...m }));
  }

  private record(
    at: number,
    model: string,
    date: string,
    type: MovementType,
    qty: number,
    reason: string,
    ref?: string,
    patientId?: string,
  ): StockMovement {
    moveCounter += 1;
    const movement: StockMovement = {
      id: `mv-${moveCounter}`,
      at,
      model,
      date,
      type,
      qty,
      reason,
      ref,
    };
    this.movements.push(movement);
    this.audit.append({
      at,
      type: "stock-movement",
      patientId: patientId ?? "-",
      author: "device-ledger",
      rationale: reason,
      refs: { movement: movement.id, model, date, qty, mvType: type },
    });
    return movement;
  }
}
