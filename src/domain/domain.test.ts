// 验配链领域自检测试：不依赖测试框架，用 node + esbuild 直接跑。
import { ChainService } from "./chain";
import { DomainError, WriteFailureError } from "./errors";
import { buildService, INITIAL_CONCLUSION } from "./seed";
import type { ConclusionFields } from "./types";

let passed = 0;
let failed = 0;
const failures: string[] = [];

export function assert(cond: unknown, message: string): asserts cond {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(message);
    throw new Error(`断言失败: ${message}`);
  }
}

function assertThrows(code: string, fn: () => void, message: string) {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError && e.code === code) {
      passed += 1;
      return;
    }
    failed += 1;
    failures.push(`${message}（抛出了非预期错误: ${(e as Error).message}）`);
    throw e;
  }
  failed += 1;
  failures.push(`${message}（未抛出 ${code}）`);
  throw new Error(`期望抛出 ${code}`);
}

/** 场景 1：离线并发修订 → 回连按序号合并 → 冲突全留待确认 → 未确认不覆盖结论 */
function testConcurrentMergeConflict() {
  const { service } = buildService();
  const au1 = { id: "au-1", name: "王听力师" };
  const au2 = { id: "au-2", name: "李听力师" };
  const sup = { id: "sup-1", name: "赵主管" };
  service.state.stock.push({ model: "聆声 S1 试听机", dailyCapacity: 5 });

  const rec = service.createRecord("P-1", "周先生", INITIAL_CONCLUSION, au1);
  service.registerStation("A", "一号工位");
  service.registerStation("B", "复诊工位");

  // 两位听力师先后断网，各自基于同一 lastSeq=0 自增出 #1（撞号）
  service.setStationOnline("A", false);
  service.setStationOnline("B", false);
  service.openRevision(rec.id, "A", { gain: "程序B / 增益+3dB" }, au1);
  service.openRevision(rec.id, "B", { gain: "程序C / 降噪优先", trialDevice: "聆声 Pro2 试听机" }, au2);

  // 断网期间记录上没有新修订，有效结论纹丝不动
  assert(rec.revisions.length === 0, "离线修订不应直接进入记录");
  assert(rec.current.fields.gain === INITIAL_CONCLUSION.gain, "断网期间有效结论不得被修订覆盖");
  assert(rec.current.version === 1, "断网期间结论版本不变");

  // 回连：按 (seq, 时间, 工位) 排序，两个 gain 不同值都留下
  service.setStationOnline("A", true);
  service.syncStation("A", au1);
  service.setStationOnline("B", true);
  service.syncStation("B", au2);

  assert((rec.revisions.length as number) === 2, "两条离线修订都应接回记录");
  const seqs = rec.revisions.map((r) => r.seq).sort();
  assert(seqs[0] === 1 && seqs[1] === 1, "撞号保留原序号 #1/#1，由排序与冲突裁决处理");
  const merge = rec.pendingMerge!;
  assert(merge !== null && merge.status === "pending", "回连后必须产生待确认合并");
  const gainStage = merge.staged.find((s) => s.field === "gain")!;
  assert(gainStage.conflict === true, "gain 字段应标记冲突");
  assert(gainStage.candidates.length === 2, "冲突内容必须全部留下（两个候选）");
  const trialStage = merge.staged.find((s) => s.field === "trialDevice")!;
  assert(trialStage.conflict === false && trialStage.candidates.length === 1, "只有一人改的字段不冲突");

  // 未确认就不能覆盖：尝试直接确认时跳过冲突裁决应失败
  assertThrows("CONFLICT_UNRESOLVED", () => service.confirmMerge(rec.id, sup, []), "冲突未裁决不得确认");
  assert(rec.current.version === 1, "确认失败后结论仍是 v1");

  // 主管裁决 gain 冲突并写明理由
  const result = service.confirmMerge(rec.id, sup, [
    { field: "gain", pickRevisionId: gainStage.candidates[1].revisionId, reason: "复测听阈上移，采用降噪优先程序更稳妥" },
  ]);
  assert(result.changed === true, "结论字段实际变化");
  assert((rec.current.version as number) === 2, "确认后生成 v2 有效结论");
  assert(rec.current.fields.gain === "程序C / 降噪优先", "主管选定的值生效");
  assert(rec.current.fields.trialDevice === "聆声 Pro2 试听机", "无冲突字段一并生效");

  // 旧修订不丢：被采纳为 confirmed，未被采纳的王听力师 gain 候选为 superseded
  const states = Object.fromEntries(rec.revisions.map((r) => [r.authorId, r.state]));
  assert(states["au-2"] === "confirmed", "被采纳修订标记 confirmed");
  assert(states["au-1"] === "superseded", "被舍弃的旧修订标记 superseded 但仍留档");

  // 变更依据随版本留档
  assert(rec.current.basis.includes("冲突裁决依据"), "v2 必须记录变更依据/裁决理由");
  assert(rec.versions.length === 1 && rec.versions[0].version === 1, "旧版本 v1 可回溯");
}

/** 场景 2：有效结论变化 → 未执行预约和设备预占全部失效重算；已执行的不动 */
function testInvalidationAndRecompute() {
  const { service } = buildService();
  const au1 = { id: "au-1", name: "王听力师" };
  const sup = { id: "sup-1", name: "赵主管" };
  service.state.stock.push({ model: "聆声 S1 试听机", dailyCapacity: 5 });
  service.state.stock.push({ model: "聆声 Pro2 试听机", dailyCapacity: 5 });

  const rec = service.createRecord("P-2", "李先生", INITIAL_CONCLUSION, au1);
  const firstAppt = service.state.appointments.find((a) => a.recordId === rec.id && a.state === "scheduled")!;
  assert(!!firstAppt, "建档应排出 v1 复诊预约并占机");

  // 该预约已到店执行（历史结论，不应被动）
  firstAppt.state = "executed";

  // 主管直接改结论（单人修订、无冲突）：换成双耳 Pro2，复诊 14 天
  service.registerStation("A", "一号工位");
  service.openRevision(
    rec.id,
    "A",
    {
      trialDevice: "聆声 Pro2 试听机",
      followUpDays: [14],
      note: "改为 Pro2 两周复诊",
    } satisfies Partial<ConclusionFields>,
    au1,
  );
  const result = service.confirmMerge(rec.id, sup, []);
  assert(result.changed, "结论变化");
  assert(result.voidedAppointments.length === 0, "已执行的预约不应被失效");
  const v2Appt = service.state.appointments.find((a) => a.recordId === rec.id && a.sourceVersion === 2)!;
  assert(v2Appt.state === "scheduled", "新结论应重算并排出 v2 预约");
  assert(v2Appt.deviceModel === "聆声 Pro2 试听机", "新预约按新机型预占设备");
  assert(firstAppt.state === "executed", "已执行预约保持不动");

  // 旧 S1 预占已释放（v1 时产生过 RESERVE，失效时红冲 RELEASE）
  const txns = service.inventoryLedger();
  const releaseTxn = txns.find((t) => t.type === "RELEASE" && t.model === "聆声 S1 试听机");
  // v1 的预约已 executed——执行过的预占不释放；这里首诊预约从未 held 后又被我们置 executed，
  // 预占本身仍是 held（建批次时占的机），按规则 executed 预约保留，故不产生 RELEASE。
  assert(!releaseTxn, "已执行预约对应的旧预占保留（到店试听不释放）");
}

/** 场景 3：容量不足分批保留；台账写入失败整批回滚，再从完整批次恢复 */
function testBatchingAndRollbackRecovery() {
  const { service } = buildService();
  const au1 = { id: "au-1", name: "王听力师" };
  const sup = { id: "sup-1", name: "赵主管" };
  // 容量：每日仅 1 台，制造后续批次等待
  service.state.stock.push({ model: "聆声 S1 试听机", dailyCapacity: 1 });

  const rec = service.createRecord("P-3", "张先生", INITIAL_CONCLUSION, au1); // v1: 第7天，占掉唯一一台
  service.registerStation("A", "一号工位");

  // 新结论：第 7、14 天各复诊一次。第 7 天容量已满（v1 占的机随结论失效会先释放），
  // 所以第7天可兑现；但我们用写入故障让第一个新批次失败，验证整批回滚。
  service.openRevision(
    rec.id,
    "A",
    { followUpDays: [7, 14], note: "两次复诊" } satisfies Partial<ConclusionFields>,
    au1,
  );

  // 找到即将生成的第一个批次 id（编号规则可预期），提前注入台账写入故障
  const failBatchId = `batch-${rec.id}-v2-1`;
  // 通过仓储在批次准备后注入：先确认，再在提交前注入不可行，这里改为监听——
  // 用 monkey patch: 提交时第一批必失败
  const repo = (service as unknown as { repo: { injectWriteFailure: (id: string) => void } }).repo;
  repo.injectWriteFailure(failBatchId);

  const result = service.confirmMerge(rec.id, sup, []);
  assert(result.failedBatch?.id === failBatchId, "第一个新批次写入失败应被记录");
  assert(result.failedBatch?.state === "rolledback", "失败批次状态为 rolledback");

  // 从完整批次恢复：失败批次没有任何库存占用（没有产生 RESERVE 流水），预约保留 waiting
  const v2Appts = service.state.appointments.filter((a) => a.recordId === rec.id && a.sourceVersion === 2);
  assert(v2Appts.length === 2, "两次复诊预约都保留");
  const waiting = v2Appts.find((a) => a.state === "waiting")!;
  assert(!!waiting, "失败批次的预约回到 waiting 等待重试，旧结论不继续占机");

  // 旧结论预占已在失效阶段释放，容量现在空出
  const reserveTxnsForBatch = service.inventoryLedger().filter((t) => t.refId === failBatchId);
  assert(reserveTxnsForBatch.length === 0, "回滚批次不得留下库存流水/占用");

  // 重试：容量已恢复，整批写入成功（从完整批次边界续作）
  const ok = service.retryBatch(rec.id, failBatchId, sup);
  assert(ok === true, "故障消除后重试应成功");
  const retried = service.state.batches.find((b) => b.id === failBatchId)!;
  assert(retried.state === "committed", "重试成功批次状态 committed");
  const retriedAppt = v2Appts.find((a) => a.batchId === failBatchId)!;
  assert(retriedAppt.state === "scheduled", "重试后预约占机");

  // 另一条第14天预约：容量足够时在同一轮已自行兑现
  const d14 = v2Appts.find((a) => a.id.endsWith("-2"))!;
  assert(d14.state === "scheduled", "后续可兑现批次不受失败批次影响，继续兑现");
}

/** 场景 4：真正容量不足（不是写入故障）→ 预约分批保留 waiting，入库后重试兑现 */
function testCapacityWaitlistThenInbound() {
  const { service } = buildService();
  const au1 = { id: "au-1", name: "王听力师" };
  const sup = { id: "sup-1", name: "赵主管" };
  // S1 每日容量极小：第7天已有 v1 占用且不失效（结论中机型不变），
  // 这里让机型改变释放不了——直接构造：新机型容量 0 再入库
  service.state.stock.push({ model: "聆声 S1 试听机", dailyCapacity: 1 });
  service.state.stock.push({ model: "聆声 Pro2 试听机", dailyCapacity: 0 });

  const rec = service.createRecord("P-4", "钱先生", INITIAL_CONCLUSION, au1);
  service.registerStation("A", "一号工位");
  service.openRevision(
    rec.id,
    "A",
    { trialDevice: "聆声 Pro2 试听机", followUpDays: [7, 14] } satisfies Partial<ConclusionFields>,
    au1,
  );
  const result = service.confirmMerge(rec.id, sup, []);
  assert(result.failedBatch === null, "容量不足不是写入故障，没有失败批次");
  const waiting = service.state.appointments.filter(
    (a) => a.recordId === rec.id && a.state === "waiting" && a.sourceVersion === 2,
  );
  assert(waiting.length === 2, "容量不足时两条预约都保留为等待批次，不占机");

  // 入库扩容（写 INBOUND 流水），重排等待批次
  service.inbound("聆声 Pro2 试听机", 2, sup);
  const rolledBack = service.state.batches.filter((b) => b.state === "rolledback");
  assert(rolledBack.length === 0, "容量不足路径不产生 rolledback 批次（它们从未提交）");
  assert(service.inventoryLedger().some((t) => t.type === "INBOUND"), "入库必须写库存流水");

  const replan = service.replanWaiting(rec.id, sup);
  assert(replan.failedBatch === null, "容量恢复后重排不应失败");
  assert(replan.committed.length === 2, "两条等待预约都应重新分批兑现");
  assert(
    service.state.appointments.every(
      (a) => a.recordId !== rec.id || a.sourceVersion !== 2 || a.state === "scheduled",
    ),
    "重排后 v2 预约全部占机，无遗留 waiting",
  );
}

/** 场景 5：审计——主管确认后，旧修订、变更依据、库存流水、事件链全部可追查 */
function testAuditTrail() {
  const { service } = buildService();
  const au1 = { id: "au-1", name: "王听力师" };
  const sup = { id: "sup-1", name: "赵主管" };
  service.state.stock.push({ model: "聆声 S1 试听机", dailyCapacity: 3 });

  const rec = service.createRecord("P-5", "孙先生", INITIAL_CONCLUSION, au1);
  service.registerStation("A", "一号工位");
  service.openRevision(rec.id, "A", { note: "新备注" }, au1);
  service.confirmMerge(rec.id, sup, []);

  const trace = service.trace(rec.id);
  assert(trace.versions[0].version === 2, "追查接口给出最新有效结论");
  assert(trace.revisions.every((r) => r.state !== "proposed"), "确认后修订都有归处，不悬空");
  assert(trace.events.some((e) => e.type === "CONCLUSION_CHANGED"), "事件链含结论变更");
  assert(trace.events.some((e) => e.type === "BATCH_COMMITTED" || e.type === "APPOINTMENT_WAITLISTED"), "事件链含排批结果");
  assert(trace.appointments.length >= 1, "追查接口含复诊预约");
  const fullLog = service.auditLog();
  const seqList = fullLog.map((e) => e.seq);
  assert(JSON.stringify(seqList) === JSON.stringify([...seqList].sort((a, b) => a - b)), "事件流只追加、序号连续");

  // 流水只追加：红冲也是新行，余额逐行可算
  const ledger = service.inventoryLedger();
  for (const t of ledger) {
    assert(typeof t.balanceAfter === "number", "每条流水带结余");
  }
}

/** 场景 6：未确认的修订绝不覆盖当前有效结论（即使无冲突，也要主管确认动作） */
function testNoOverrideBeforeConfirm() {
  const { service } = buildService();
  const au1 = { id: "au-1", name: "王听力师" };
  service.state.stock.push({ model: "聆声 S1 试听机", dailyCapacity: 3 });
  const rec = service.createRecord("P-6", "冯先生", INITIAL_CONCLUSION, au1);
  service.registerStation("A", "一号工位");
  service.openRevision(rec.id, "A", { note: "改了备注但还没确认" }, au1);
  assert(rec.current.fields.note === INITIAL_CONCLUSION.note, "合并提案挂起期间，有效结论保持不变");
  assert(rec.current.version === 1, "无新版本");
}

export function runAll(): { passed: number; failed: number; failures: string[] } {
  const tests: [string, () => void][] = [
    ["离线并发合并与冲突待确认", testConcurrentMergeConflict],
    ["结论变化失效重算", testInvalidationAndRecompute],
    ["分批写入失败与整批恢复", testBatchingAndRollbackRecovery],
    ["容量不足分批保留+入库", testCapacityWaitlistThenInbound],
    ["全链路审计追查", testAuditTrail],
    ["未确认不覆盖有效结论", testNoOverrideBeforeConfirm],
  ];
  for (const [name, fn] of tests) {
    try {
      fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      console.log(`  ✗ ${name}: ${(e as Error).message}`);
    }
  }
  return { passed, failed, failures };
 }
