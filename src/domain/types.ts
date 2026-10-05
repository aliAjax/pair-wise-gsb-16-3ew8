// 验配链领域模型：验配记录（修订） / 复诊预约 / 试听设备台账 三类记录接成一条链
// 设计原则：结论只能向前追加版本、流水只能追加不能改写、下游占用随有效结论失效重算。

export type Ear = "L" | "R" | "BOTH";

/** 验配结论的业务字段，两个听力师并发修订的合并粒度就是“字段” */
export interface ConclusionFields {
  /** 建议机型 */
  aidModel: string;
  /** 验配耳别 */
  ear: Ear;
  /** 增益/程序参数 */
  gain: string;
  /** 建议试听机型（预约排诊与设备预占据此计算） */
  trialDevice: string;
  /** 复诊计划：确认生效后第 N 天到店 */
  followUpDays: number[];
  /** 听力师备注 */
  note: string;
}

export type RevisionState = "proposed" | "confirmed" | "superseded";

/** 一次离线/在线修订：只记录“改了哪些字段”，不直接碰有效结论 */
export interface Revision {
  id: string;
  /** 修订序号：工位基于已知序号自增，离线并发可能撞号，合并时按 (seq, 工位, 时间) 排序 */
  seq: number;
  clientId: string;
  authorId: string;
  authorName: string;
  /** 乐观锁：修订时所依据的有效结论版本 */
  baseVersion: number;
  createdAt: number;
  fields: Partial<ConclusionFields>;
  state: RevisionState;
}

/** 合并后某个字段上的候选值；不同值全部保留为待确认 */
export interface FieldCandidate {
  revisionId: string;
  seq: number;
  authorId: string;
  authorName: string;
  value: unknown;
}

export interface StagedField {
  field: keyof ConclusionFields;
  candidates: FieldCandidate[];
  /** 候选值不一致即为冲突，必须由主管拍板 */
  conflict: boolean;
}

export type MergeStatus = "pending" | "confirmed";

/** 多个修订按序号合并后的待确认提案 */
export interface MergeState {
  id: string;
  recordId: string;
  /** 参与合并的修订，按序号排序 */
  revisionIds: string[];
  staged: StagedField[];
  hasConflicts: boolean;
  status: MergeStatus;
  mergedAt: number;
}

/** 生效的结论版本：只追加，不改写 */
export interface ConclusionVersion {
  version: number;
  fields: ConclusionFields;
  confirmedBy: string;
  confirmedByName: string;
  confirmedAt: number;
  /** 变更依据：合并提案、冲突裁决、理由全部留档 */
  basis: string;
  mergeId?: string;
  revisionIds: string[];
}

export interface FittingRecord {
  id: string;
  patientId: string;
  patientName: string;
  /** 已分配的最大修订序号 */
  lastSeq: number;
  revisions: Revision[];
  current: ConclusionVersion;
  versions: ConclusionVersion[];
  pendingMerge: MergeState | null;
  createdAt: number;
}

export type AppointmentState =
  | "scheduled" // 已排诊、已占机
  | "waiting" // 容量不足，预约保留但未占机（后续批次）
  | "executed" // 已到店执行，历史不动
  | "invalidated"; // 结论变化导致失效

export interface Appointment {
  id: string;
  recordId: string;
  patientName: string;
  dueDate: string; // YYYY-MM-DD
  reason: string;
  sourceVersion: number;
  state: AppointmentState;
  /** 失效/排队依据（事件号），便于追查 */
  refEventId?: string;
  batchId?: string;
  deviceModel?: string;
}

export type ReservationState =
  | "prepared" // 批次已准备、尚未写入台账（不占容量，失败可整批丢弃）
  | "held" // 批次提交成功、正式占机
  | "voided" // 旧结论失效或批次回滚后释放
  | "fulfilled"; // 到店试听已兑现

export interface DeviceReservation {
  id: string;
  recordId: string;
  appointmentId: string;
  model: string;
  dueDate: string;
  state: ReservationState;
  sourceVersion: number;
  batchId?: string;
  createdAt: number;
  voidedAt?: number;
}

/** 库存台账设备：每日可排容量 */
export interface DeviceStock {
  model: string;
  dailyCapacity: number;
}

export type InventoryTxnType = "RESERVE" | "RELEASE" | "INBOUND";

/** 库存流水：只追加，每条带当日结余，作废也是红冲式追加 */
export interface InventoryTxn {
  id: string;
  seq: number;
  at: number;
  type: InventoryTxnType;
  model: string;
  dueDate: string;
  qty: number;
  /** 该机型当日占用后的剩余可排容量 */
  balanceAfter: number;
  refType: string;
  refId: string;
  operator: string;
}

/** 提交批次：按日期切批，整批写入，失败整批回滚 */
export interface CommitBatch {
  id: string;
  recordId: string;
  ordinal: number;
  dueDate: string;
  items: { appointmentId: string; reservationId: string; model: string }[];
  state: "prepared" | "committed" | "rolledback";
}

/** 审计事件：只追加的验配链时间线 */
export interface ChainEvent {
  id: string;
  seq: number;
  at: number;
  type: string;
  recordId: string;
  actor: string;
  summary: string;
  payload?: Record<string, unknown>;
  refRevisionIds?: string[];
}

export interface Station {
  id: string;
  name: string;
  online: boolean;
  /** 断网期间本地暂存的修订（可续作：持久化，刷新不丢） */
  queuedRevisionIds: string[];
  /** 断网期间本地暂存的修订实体（其他工位在回连前看不到） */
  outbox: Revision[];
  /** 工位已知的最大修订序号 */
  knownSeq: number;
}
