export class DomainError extends Error {
  constructor(
    public code:
      | "RECORD_NOT_FOUND"
      | "REVISION_EMPTY"
      | "MERGE_NOT_PENDING"
      | "CONFLICT_UNRESOLVED"
      | "UNKNOWN_FIELD"
      | "INVALID_VALUE"
      | "STATION_NOT_FOUND"
      | "STATION_ONLINE"
      | "STATION_OFFLINE"
      | "BATCH_NOT_FOUND"
      | "BATCH_STATE",
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

/** 写入故障注入：模拟“设备台账写入失败”，由仓储层抛出 */
export class WriteFailureError extends Error {
  constructor(
    public batchId: string,
    public causeMessage: string,
  ) {
    super(`批次 ${batchId} 写入失败: ${causeMessage}`);
    this.name = "WriteFailureError";
  }
}
