import { runAll } from "./domain.test";

declare const process: { exit(code: number): void };

const { passed, failed } = runAll();
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
