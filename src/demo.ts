/**
 * 演示引导：开机即处于真实的断网复诊现场。
 * 刘阿姨 v1 已排上 10-08 的 RIC-200 试听；陈大爷同日需求因只有 1 台而顺延。
 * 接下来可由两位听力师断网改同一份记录、主管裁决、确认换型、重排与追查。
 */
import { FittingChain } from "./domain/chain";
import { FieldValues } from "./domain/types";

export const DAY1 = "2026-10-08";
export const T0 = Date.parse("2026-10-05T09:00:00Z");

export const LIU_INITIAL: FieldValues = {
  leftPta: "48",
  rightPta: "52",
  speechScore: "64",
  deviceModel: "RIC-200",
  gainAdjust: "高频 +2dB",
  feedback: "嘈杂环境听不清",
};

export const CHEN_INITIAL: FieldValues = {
  leftPta: "55",
  rightPta: "40",
  speechScore: "58",
  deviceModel: "RIC-200",
  gainAdjust: "低频压缩 -2dB",
  feedback: "打电话偶尔啸叫",
};

export function bootDemoChain(): FittingChain {
  const chain = new FittingChain();

  // 试听设备铺货：10-08 当天 RIC-200 只有 1 台，RIC-300 有 2 台
  chain.ledger.inbound("RIC-200", 1, T0, "门店铺货");
  chain.ledger.inbound("RIC-300", 2, T0, "门店铺货");
  // 当日诊位容量
  chain.scheduler.setDailySlots(DAY1, 4);

  chain.createRecord({
    id: "rec-liu-024",
    patientId: "P-024",
    patientName: "刘阿姨",
    initial: { ...LIU_INITIAL },
    at: T0,
  });
  chain.setFollowUpSpec("rec-liu-024", { preferredDate: DAY1, priority: 9 });
  chain.revise("rec-liu-024", {
    clientId: "seed-liu-v1",
    author: "听力师甲",
    baseSeq: 0,
    basis: "初配完成，预约 RIC-200 试听",
    changes: { feedback: "初配完成，等待试听" },
    at: T0 + 60_000,
  });
  chain.confirm("rec-liu-024", "门店主管·周敏", T0 + 120_000, "初配结论 v1 生效");

  chain.createRecord({
    id: "rec-chen-118",
    patientId: "P-118",
    patientName: "陈大爷",
    initial: { ...CHEN_INITIAL },
    at: T0,
  });
  chain.setFollowUpSpec("rec-chen-118", { preferredDate: DAY1, priority: 5 });
  chain.revise("rec-chen-118", {
    clientId: "seed-chen-v1",
    author: "听力师乙",
    baseSeq: 0,
    basis: "初配完成，同日试听需求",
    changes: { feedback: "初配完成，等待试听" },
    at: T0 + 180_000,
  });
  // RIC-200 当日容量已被刘阿姨占满：陈大爷的预约整批顺延，不做半批写入
  chain.confirm("rec-chen-118", "门店主管·周敏", T0 + 240_000, "初配结论 v1 生效");

  return chain;
}

/** 一键载入“两位听力师断网复诊同一份记录”的样例修订 */
export function loadOfflineFollowUps(chain: FittingChain): void {
  const at = Date.now();
  chain.revise("rec-liu-024", {
    clientId: `off-a-${at}`,
    author: "听力师甲",
    baseSeq: 1,
    basis: "门店复诊复测：试听后建议升级 RIC-300，高频补偿加到 +4dB",
    changes: { deviceModel: "RIC-300", gainAdjust: "高频 +4dB" },
    at,
  });
  chain.revise("rec-liu-024", {
    clientId: `off-b-${at + 1}`,
    author: "听力师乙",
    baseSeq: 1,
    basis: "断网期间复测：言语识别率升至 76%，建议高频 +5dB",
    changes: { speechScore: "76", gainAdjust: "高频 +5dB" },
    at: at + 1000,
  });
}
