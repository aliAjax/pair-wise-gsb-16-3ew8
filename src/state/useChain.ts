import { useCallback, useMemo, useSyncExternalStore } from "react";
import { ChainService } from "../domain/chain";
import { Repository } from "../domain/storage";
import { seedScenario, type SeedContext } from "../domain/seed";

let ctx: SeedContext | null = null;

function boot(fresh = false): SeedContext {
  if (ctx) return ctx;
  if (!fresh) {
    const repo = Repository.load();
    if (repo.state.records.length > 0) {
      ctx = {
        service: new ChainService(repo),
        recordId: repo.state.records[0].id,
        stationA: "station-A",
        stationB: "station-B",
        audiologist1: { id: "au-1", name: "王听力师" },
        audiologist2: { id: "au-2", name: "李听力师" },
        supervisor: { id: "sup-1", name: "赵主管" },
      };
      return ctx;
    }
  }
  ctx = seedScenario();
  ctx.service.state;
  // 种子数据立即持久化，断网刷新也可续作
  (ctx.service as unknown as { repo: Repository }).repo.save();
  return ctx;
}

// 订阅：领域服务每次变更都落 localStorage，用 storage 事件 + 手动通知驱动刷新
const listeners = new Set<() => void>();
function notify() {
  listeners.forEach((l) => l());
}

export function useChain() {
  const context = useMemo(() => boot(), []);
  const service = context.service;

  const version = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => service.state.events.length + service.state.txns.length + service.state.batches.length,
  );

  const act = useCallback(<T,>(fn: () => T): T => {
    const r = fn();
    notify();
    return r;
  }, []);

  const resetDemo = useCallback(() => {
    localStorage.removeItem("hxwl-fitting-chain-v1");
    ctx = null;
    location.reload();
  }, []);

  return { ctx: context, version, act, resetDemo };
}
