import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FieldValues } from "./types";
import { FittingChain } from "./chain";

const DAY1 = "2026-10-08";
const DAY2 = "2026-10-09";
const t0 = Date.parse("2026-10-05T09:00:00Z");

const initial: FieldValues = {
  leftPta: "48",
  rightPta: "52",
  speechScore: "64",
  deviceModel: "RIC-200",
  gainAdjust: "高频 +2dB",
  feedback: "嘈杂环境听不清",
};

function bootChain() {
  const chain = new FittingChain();
  chain.ledger.inbound("RIC-200", 1, t0, "门店铺货");
  chain.ledger.inbound("RIC-300", 2, t0, "门店铺货");
  chain.scheduler.setDailySlots(DAY1, 2);
  const rec = chain.createRecord({
    id: "rec-1",
    patientId: "P-1",
    patientName: "刘阿姨",
    initial,
    at: t0,
  });
  chain.setFollowUpSpec("rec-1", { preferredDate: DAY1, priority: 5 });
  return { chain, rec };
}

describe("验配链联动", () => {
  it("初版确认后排上复诊并预占设备，台账与诊位容量随之下降", () => {
    const { chain } = bootChain();
    // 初版结论也走一次确认流程以建立预约
    chain.setFollowUpSpec("rec-1", { preferredDate: DAY1, priority: 5 });
    chain.revise("rec-1", {
      clientId: "init-tune",
      author: "听力师甲",
      baseSeq: 0,
      basis: "初配微调记录",
      changes: { feedback: "初配完成，预约试听" },
      at: t0 + 1000,
    });
    const r = chain.confirm("rec-1", "门店主管", t0 + 2000, "初配生效");
    assert.equal(r.committed, true);
    assert.equal(chain.scheduler.listAppointments("scheduled").length, 1);
    assert.equal(chain.ledger.capacityFor("RIC-200", DAY1), 0);
  });

  it("有效结论变化：旧预约失效、旧预占释放，再按新结论重算", () => {
    const { chain } = bootChain();
    // 建立 v1 的预约（设备 RIC-200 被占满）
    chain.revise("rec-1", {
      clientId: "v1",
      author: "听力师甲",
      baseSeq: 0,
      basis: "初配",
      changes: { feedback: "初配" },
      at: t0 + 1000,
    });
    chain.confirm("rec-1", "门店主管", t0 + 2000, "初配生效");
    assert.equal(chain.ledger.reserved("RIC-200", DAY1), 1);

    // 断网复诊：两名听力师先后改了型号/增益，主管裁决换型 RIC-300
    chain.revise("rec-1", {
      clientId: "off-a",
      author: "听力师甲",
      baseSeq: 1,
      basis: "试听后建议升级 RIC-300",
      changes: { deviceModel: "RIC-300", gainAdjust: "高频 +4dB" },
      at: t0 + 86_400_000,
    });
    chain.revise("rec-1", {
      clientId: "off-b",
      author: "听力师乙",
      baseSeq: 1,
      basis: "复测言语识别率改善",
      changes: { speechScore: "76", gainAdjust: "高频 +5dB" },
      at: t0 + 86_401_000,
    });
    // 增益冲突：采纳甲
    const batch = chain.getRecord("rec-1").getPendingBatch()!;
    const seqA = batch.fields.gainAdjust!.candidates.find((c) => c.author === "听力师甲")!.seq;
    chain.resolveConflict("rec-1", "gainAdjust", seqA, "门店主管");

    const result = chain.confirm("rec-1", "门店主管", t0 + 86_500_000, "复诊结论：升级机型并重新排诊");

    assert.equal(result.version, 3);
    assert.ok(result.changedFields.includes("deviceModel"));
    // 旧预约失效、RIC-200 预占释放
    assert.equal(result.invalidated.length, 1);
    assert.equal(chain.ledger.reserved("RIC-200", DAY1), 0);
    // 新预约按 RIC-300 重算并预占
    assert.equal(chain.scheduler.listAppointments("scheduled").length, 1);
    assert.equal(chain.scheduler.listAppointments("scheduled")[0].model, "RIC-300");
    assert.equal(chain.ledger.reserved("RIC-300", DAY1), 1);
    // 不存在“失效预约仍占机”
    assert.equal(chain.scheduler.listAppointments("invalidated").length, 1);
  });

  it("设备容量不足：只保留可兑现的完整批次，不足者顺延；补库存后可重算", () => {
    const chain = new FittingChain();
    chain.ledger.inbound("RIC-200", 1, t0, "铺货");
    chain.scheduler.setDailySlots(DAY1, 2);

    // 两位患者都要 RIC-200，当日只有 1 台
    for (const [id, patient, prio] of [
      ["rec-1", "P-1", 9],
      ["rec-2", "P-2", 3],
    ] as const) {
      chain.createRecord({
        id,
        patientId: patient,
        patientName: patient,
        initial: { ...initial },
        at: t0,
      });
      chain.setFollowUpSpec(id, { preferredDate: DAY1, priority: prio });
      chain.revise(id, {
        clientId: `init-${id}`,
        author: "听力师甲",
        baseSeq: 0,
        basis: "初配",
        changes: { feedback: "初配" },
        at: t0,
      });
    }
    const r1 = chain.confirm("rec-1", "门店主管", t0 + 1000, "生效");
    const r2 = chain.confirm("rec-2", "门店主管", t0 + 2000, "生效");

    assert.equal(r1.committed, true);
    // 第二个患者容量不足：批次为空兑现，请求顺延而不是硬写
    assert.equal(r2.appointmentIds.length, 0);
    assert.deepEqual(chain.scheduler.deferredRequestIds("rec-2"), ["fr-rec-2-v2"]);
    assert.equal(chain.ledger.reserved("RIC-200", DAY1), 1);

    // 设备调拨到店后重算，顺延请求兑现
    chain.ledger.inbound("RIC-200", 1, t0 + 3000, "紧急调拨");
    const retried = chain.retryDeferred("rec-2", t0 + 4000)!;
    assert.equal(retried.appointmentIds.length, 1);
    assert.equal(chain.ledger.reserved("RIC-200", DAY1), 2);
    assert.deepEqual(chain.scheduler.deferredRequestIds("rec-2"), []);
  });

  it("批次写入中途失败：库存与预约整体回滚到提交前，可原样重试成功", () => {
    const chain = new FittingChain();
    chain.ledger.inbound("RIC-300", 3, t0, "铺货");
    chain.scheduler.setDailySlots(DAY2, 5);

    chain.createRecord({
      id: "rec-1",
      patientId: "P-1",
      patientName: "刘阿姨",
      initial: { ...initial },
      at: t0,
    });
    chain.setFollowUpSpec("rec-1", { preferredDate: DAY2, priority: 5 });
    chain.revise("rec-1", {
      clientId: "v1",
      author: "听力师甲",
      baseSeq: 0,
      basis: "初配",
      changes: { deviceModel: "RIC-300", feedback: "换型" },
      at: t0 + 1000,
    });

    // 让唯一一条预约在写入时失败
    const failed = chain.confirm("rec-1", "门店主管", t0 + 2000, "换型生效", {
      failAtAssignment: 0,
    });
    assert.equal(failed.committed, false);
    assert.match(failed.error ?? "", /写入失败/);
    // 没有半成品预约，设备没有被幽灵预占
    assert.equal(chain.scheduler.listAppointments("scheduled").length, 0);
    assert.equal(chain.ledger.reserved("RIC-300", DAY2), 0);
    // 回滚事件本身留痕，但没有残留 reserve 流水
    const movements = chain.stockMovements("RIC-300");
    assert.equal(movements.some((m) => m.type === "reserve" && m.date === DAY2), false);
    assert.ok(chain.timeline("P-1").some((e) => e.type === "batch-rolled-back"));

    // 结论版本已经换了（确认成功），只是排诊批次没写成 → 原样重试
    const retried = chain.retryDeferred("rec-1", t0 + 3000);
    assert.equal(retried?.committed, true);
    assert.equal(chain.scheduler.listAppointments("scheduled").length, 1);
    assert.equal(chain.ledger.reserved("RIC-300", DAY2), 1);
  });

  it("主管确认后：旧修订、变更依据、库存流水都在同一条时间线可追查", () => {
    const { chain } = bootChain();
    // v1：RIC-200 预约建立、预占
    chain.revise("rec-1", {
      clientId: "v1",
      author: "听力师甲",
      baseSeq: 0,
      basis: "初配完成",
      changes: { feedback: "初配完成，预约试听" },
      at: t0 + 1000,
    });
    chain.confirm("rec-1", "门店主管", t0 + 2000, "初配生效");

    // v2：复诊升级机型，旧 RIC-200 预占失效、RIC-300 重排
    chain.revise("rec-1", {
      clientId: "off-a",
      author: "听力师甲",
      baseSeq: 1,
      basis: "试听后建议升级 RIC-300",
      changes: { deviceModel: "RIC-300" },
      at: t0 + 86_400_000,
    });
    chain.confirm("rec-1", "门店主管", t0 + 86_500_000, "复诊结论：升级机型");

    const timeline = chain.timeline("P-1").map((e) => e.type);
    assert.ok(timeline.includes("revision-merged"));
    assert.ok(timeline.includes("batch-confirmed"));
    assert.ok(timeline.includes("appointment-invalidated"));
    assert.ok(timeline.includes("appointment-rebooked"));

    // 变更依据可查（找到升级机型对应的那条修订）
    const upgradeRev = chain
      .timeline("P-1")
      .find((e) => e.type === "revision-merged" && (e.rationale ?? "").includes("升级 RIC-300"))!;
    assert.ok(upgradeRev);
    assert.match(upgradeRev.rationale ?? "", /试听后建议升级/);
    const confirmEvts = chain.timeline("P-1").filter((e) => e.type === "batch-confirmed");
    const lastConfirm = confirmEvts[confirmEvts.length - 1];
    assert.match(lastConfirm.rationale ?? "", /升级机型/);
    assert.ok(Number(lastConfirm.refs?.version) >= 2);

    // 旧修订仍可按序号/批次追查（归档而非删除）
    const archived = chain.getRecord("rec-1").listRevisions().filter((r) => r.archived);
    assert.equal(archived.length, 2);
    assert.ok(archived.some((r) => r.basis === "试听后建议升级 RIC-300"));

    // 库存流水：release（旧预占失效）+ reserve（新预占）都在
    const movements = chain.stockMovements();
    assert.ok(movements.some((m) => m.type === "release"));
    assert.ok(movements.some((m) => m.type === "reserve"));
  });

  it("确认批次无实质字段变化时，不折腾下游预约", () => {
    const { chain } = bootChain();
    chain.revise("rec-1", {
      clientId: "v1",
      author: "听力师甲",
      baseSeq: 0,
      basis: "初配",
      changes: { feedback: "初配完成" },
      at: t0 + 1000,
    });
    chain.confirm("rec-1", "门店主管", t0 + 2000, "初配生效");
    const scheduledAfterFirst = chain.scheduler.listAppointments("scheduled").length;

    chain.revise("rec-1", {
      clientId: "no-op",
      author: "听力师乙",
      baseSeq: 1,
      basis: "看了一眼没改",
      changes: {},
      at: t0 + 3000,
    });
    // 空修订不会开批次；直接确认没有批次应抛错，这里验证状态不受影响
    assert.equal(chain.getRecord("rec-1").hasOpenBatch(), false);
    assert.equal(chain.scheduler.listAppointments("scheduled").length, scheduledAfterFirst);
  });
});
