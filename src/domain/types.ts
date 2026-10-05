/**
 * 验配链领域类型
 * 三个聚合共用的词汇表：验配记录（修订/结论）、复诊预约、试听设备台账。
 */

/** 验配结论中需要按修订合并的字段（听力师断网复诊时会改这些） */
export type FieldKey =
  | "leftPta"
  | "rightPta"
  | "speechScore"
  | "deviceModel"
  | "gainAdjust"
  | "feedback";

export const FIELD_KEYS: FieldKey[] = [
  "leftPta",
  "rightPta",
  "speechScore",
  "deviceModel",
  "gainAdjust",
  "feedback",
];

export const FIELD_LABELS: Record<FieldKey, string> = {
  leftPta: "左耳PTA(dB HL)",
  rightPta: "右耳PTA(dB HL)",
  speechScore: "言语识别率(%)",
  deviceModel: "助听器型号",
  gainAdjust: "增益调整",
  feedback: "用户反馈",
};

export type FieldValues = Record<FieldKey, string>;

export function cloneValues(values: FieldValues): FieldValues {
  return { ...values };
}

/** 待主管确认的字段：多个听力师的不同取值全部留作候选 */
export interface Candidate {
  value: string;
  author: string;
  seq: number;
}

export interface PendingField {
  field: FieldKey;
  /** 进入待确认状态时的当前有效值（主管可保留它而不采纳任何修订） */
  baseValue: string;
  /** 候选值 ≥ 2 即为冲突，必须裁决；只有 1 个表示可自动合并 */
  candidates: Candidate[];
  resolvedValue?: string;
  resolvedBy?: string;
}

export interface PendingBatch {
  id: string;
  openedAt: number;
  /** 参与本批次的修订序号（旧修订确认后仍可按此追查） */
  revisionSeqs: number[];
  fields: Partial<Record<FieldKey, PendingField>>;
}

/** 一次离线修订的输入 */
export interface RevisionInput {
  /** 端上幂等键：回连后重复推送同一修订不得再占序号 */
  clientId: string;
  author: string;
  /** 断网时所基于的修订序号 */
  baseSeq: number;
  /** 变更依据：本次复测数据 / 用户主诉等 */
  basis: string;
  changes: Partial<FieldValues>;
  at: number;
}

/** 修订（只增不改；确认后归档而不是删除） */
export interface Revision extends RevisionInput {
  seq: number;
  batchId: string | null;
  mergedFields: FieldKey[];
  conflictFields: FieldKey[];
  archived: boolean;
}

export interface EffectiveConclusion {
  /** 主管确认的版本号，每次生效 +1 */
  version: number;
  /** 生效时所吸纳的最新修订序号 */
  seq: number;
  values: FieldValues;
  confirmedBy?: string;
  confirmedAt?: number;
  rationale?: string;
}
