import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AuditLog } from "./audit";
import { FittingRecord } from "./fittingRecord";
import { FieldValues } from "./types";

const t0 = Date.parse("2026-10-05T09:00:00Z");

const initial: FieldValues = {
  leftPta: "48",
  rightPta: "52",
  speechScore: "64",
  deviceModel: "RIC-200",
  gainAdjust: "高频 +2dB",
  feedback: "嘈杂环境听不清",
};

function makeRecord() {
  return new FittingRecord("rec-1", "P-1", "刘阿姨", initial, t0, new AuditLog());
}

describe("断网修订按序号三方合并", () => {
  it("两个听力师改不同字段：都进入同一批次，未确认前有效结论不变", () => {
    const rec = makeRecord();
    const a = rec.submitRevision({
      clientId: "c-a",
      author: "听力师甲",
      baseSeq: 0,
      basis: "左耳复测",
      changes: { leftPta: "44" },
      at: t0 + 1000,
    });
    const b = rec.submitRevision({
      clientId: "c-b",
      author: "听力师乙",
      baseSeq: 0,
      basis: "右耳复测",
      changes: { rightPta: "49" },
      at: t0 + 2000,
    });

    assert.equal(a.revision.seq, 1);
    assert.equal(b.revision.seq, 2);
    assert.equal(a.revision.batchId, b.revision.batchId);
    // 未确认的修订不能覆盖当前有效结论
    assert.deepEqual(rec.getEffective().values, initial);
    assert.equal(rec.getEffective().version, 1);
    assert.equal(rec.unresolvedConflicts().length, 0);
  });

  it("同字段两人改出不同值：冲突内容全部留作候选待确认", () => {
    const rec = makeRecord();
    rec.submitRevision({
      clientId: "c-a",
      author: "听力师甲",
      baseSeq: 0,
      basis: "甲的复测",
      changes: { gainAdjust: "高频 +4dB" },
      at: t0 + 1000,
    });
    rec.submitRevision({
      clientId: "c-b",
      author: "听力师乙",
      baseSeq: 0,
      basis: "乙的复测",
      changes: { gainAdjust: "高频 +6dB" },
      at: t0 + 2000,
    });

    const batch = rec.getPendingBatch()!;
    const pf = batch.fields.gainAdjust!;
    const values = pf.candidates.map((c) => c.value);
    assert.ok(values.includes("高频 +4dB"));
    assert.ok(values.includes("高频 +6dB"));
    // 当前有效值也保留为候选，主管可选择不改
    assert.ok(pf.candidates.some((c) => c.value === "高频 +2dB"));
    assert.deepEqual(rec.unresolvedConflicts(), ["gainAdjust"]);
    // 有效结论仍是旧值
    assert.equal(rec.getEffective().values.gainAdjust, "高频 +2dB");
  });

  it("冲突未裁决不能确认放行", () => {
    const rec = makeRecord();
    rec.submitRevision({
      clientId: "c-a",
      author: "听力师甲",
      baseSeq: 0,
      basis: "甲",
      changes: { gainAdjust: "高频 +4dB" },
      at: t0 + 1000,
    });
    rec.submitRevision({
      clientId: "c-b",
      author: "听力师乙",
      baseSeq: 0,
      basis: "乙",
      changes: { gainAdjust: "高频 +6dB" },
      at: t0 + 2000,
    });

    assert.throws(
      () => rec.confirmBatch("门店主管", t0 + 3000, "放行"),
      /冲突未裁决/,
    );
    assert.equal(rec.getEffective().version, 1);
  });

  it("主管逐字段裁决后确认：候选生效、版本+1、旧修订归档可查", () => {
    const rec = makeRecord();
    rec.submitRevision({
      clientId: "c-a",
      author: "听力师甲",
      baseSeq: 0,
      basis: "甲的复测",
      changes: { gainAdjust: "高频 +4dB" },
      at: t0 + 1000,
    });
    rec.submitRevision({
      clientId: "c-b",
      author: "听力师乙",
      baseSeq: 0,
      basis: "乙的复测",
      changes: { gainAdjust: "高频 +6dB" },
      at: t0 + 2000,
    });

    const batch = rec.getPendingBatch()!;
    const choiceOfA = batch.fields.gainAdjust!.candidates.find((c) => c.author === "听力师甲")!.seq;
    rec.resolveConflict("gainAdjust", choiceOfA, "门店主管");
    const out = rec.confirmBatch("门店主管", t0 + 3000, "以甲的复测曲线为准");

    assert.equal(rec.getEffective().values.gainAdjust, "高频 +4dB");
    assert.equal(rec.getEffective().version, 2);
    assert.ok(out.changedFields.includes("gainAdjust"));
    assert.equal(rec.hasOpenBatch(), false);
    assert.ok(rec.listRevisions().every((r) => r.archived === true));
    assert.equal(rec.listRevisions().length, 2); // 归档不删除
  });

  it("主管可保留当前有效值（-1）：修订被拒绝但留痕", () => {
    const rec = makeRecord();
    rec.submitRevision({
      clientId: "c-a",
      author: "听力师甲",
      baseSeq: 0,
      basis: "建议大改",
      changes: { speechScore: "70" },
      at: t0 + 1000,
    });
    rec.resolveConflict("speechScore", -1, "门店主管");
    const out = rec.confirmBatch("门店主管", t0 + 2000, "复测条件不达标，维持原结论");
    assert.equal(rec.getEffective().version, 1);
    assert.equal(out.newEffective, null);
    assert.equal(rec.listRevisions()[0].archived, true);
  });

  it("回连重复推送同一 clientId：幂等忽略，不再占序号", () => {
    const rec = makeRecord();
    const first = rec.submitRevision({
      clientId: "dup-1",
      author: "听力师甲",
      baseSeq: 0,
      basis: "首次",
      changes: { leftPta: "44" },
      at: t0 + 1000,
    });
    const again = rec.submitRevision({
      clientId: "dup-1",
      author: "听力师甲",
      baseSeq: 0,
      basis: "首次",
      changes: { leftPta: "44" },
      at: t0 + 5000,
    });
    assert.equal(again.duplicated, true);
    assert.equal(again.revision.seq, first.revision.seq);
    assert.equal(rec.listRevisions().length, 1);
  });

  it("一方基于已确认的新值修订、另一方还停在旧 base：正确识别为分叉而非误覆盖", () => {
    const rec = makeRecord();
    // 甲先改型号并确认生效（seq 1）
    rec.submitRevision({
      clientId: "c-a1",
      author: "听力师甲",
      baseSeq: 0,
      basis: "换机型",
      changes: { deviceModel: "RIC-300" },
      at: t0 + 1000,
    });
    rec.confirmBatch("门店主管", t0 + 1500, "同意换机");
    assert.equal(rec.getEffective().values.deviceModel, "RIC-300");

    // 乙断网期间也改了型号，base 还是 0
    rec.submitRevision({
      clientId: "c-b1",
      author: "听力师乙",
      baseSeq: 0,
      basis: "乙建议另一机型",
      changes: { deviceModel: "BTE-500" },
      at: t0 + 2000,
    });
    const pf = rec.getPendingBatch()!.fields.deviceModel!;
    assert.ok(pf.candidates.some((c) => c.value === "RIC-300")); // 当前有效结论在候选中
    assert.ok(pf.candidates.some((c) => c.value === "BTE-500"));
    assert.deepEqual(rec.unresolvedConflicts(), ["deviceModel"]);
  });
});
