import { ChainService } from "./chain";
import { Repository } from "./storage";
import type { ConclusionFields } from "./types";

export const INITIAL_CONCLUSION: ConclusionFields = {
  aidModel: "聆声 S1",
  ear: "BOTH",
  gain: "程序A / 中度增益",
  trialDevice: "聆声 S1 试听机",
  followUpDays: [7],
  note: "初诊结论：双耳中度听损，建议双耳验配。",
};

export interface SeedContext {
  service: ChainService;
  recordId: string;
  stationA: string;
  stationB: string;
  audiologist1: { id: string; name: string };
  audiologist2: { id: string; name: string };
  supervisor: { id: string; name: string };
}

/** 固定时钟，保证演示日期与测试可复现 */
export function buildService(t0 = Date.UTC(2026, 9, 5, 2, 0, 0)): {
  service: ChainService;
  clock: { now: number; advance: (ms: number) => void };
} {
  const clock = { now: t0, advance: (ms: number) => (clock.now += ms) };
  const repo = new Repository();
  return { service: new ChainService(repo, () => clock.now), clock };
}

export function seedScenario(): SeedContext {
  const { service } = buildService();
  const audiologist1 = { id: "au-1", name: "王听力师" };
  const audiologist2 = { id: "au-2", name: "李听力师" };
  const supervisor = { id: "sup-1", name: "赵主管" };

  // 设备台账：S1 试听机每日只能排 1 人，制造“容量不足分批”
  service.state.stock.push({ model: "聆声 S1 试听机", dailyCapacity: 1 });
  service.state.stock.push({ model: "聆声 Pro2 试听机", dailyCapacity: 2 });

  const rec = service.createRecord("P-1001", "周先生", INITIAL_CONCLUSION, audiologist1);

  service.registerStation("station-A", "门店一号工位");
  service.registerStation("station-B", "门店复诊工位");

  return {
    service,
    recordId: rec.id,
    stationA: "station-A",
    stationB: "station-B",
    audiologist1,
    audiologist2,
    supervisor,
  };
}
