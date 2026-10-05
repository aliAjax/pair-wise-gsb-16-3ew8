import type {
  Appointment,
  CommitBatch,
  DeviceReservation,
  Revision,
} from "../domain/types";

export const APPOINTMENT_LABEL: Record<Appointment["state"], string> = {
  scheduled: "已排诊·占机",
  waiting: "等待批次·未占机",
  executed: "已执行",
  invalidated: "已失效",
};

export const RESERVATION_LABEL: Record<DeviceReservation["state"], string> = {
  prepared: "待写入",
  held: "占机中",
  voided: "已释放",
  fulfilled: "已兑现",
};

export const REVISION_LABEL: Record<Revision["state"], string> = {
  proposed: "待确认",
  confirmed: "已采纳",
  superseded: "已归旧",
};

export const BATCH_LABEL: Record<CommitBatch["state"], string> = {
  prepared: "已准备",
  committed: "已兑现",
  rolledback: "已回滚",
};

export function fmtTime(t: number): string {
  return new Date(t).toLocaleString("zh-CN", { hour12: false });
}
