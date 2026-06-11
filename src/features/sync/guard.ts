// 동기화 UI가 영구히 잠기지 않게 하는 안전망 (워치독 + 백오프).
// 백엔드에도 git 명령 타임아웃이 있지만, IPC 자체가 응답하지 못하는
// 경우까지 대비해 프론트에서 한 번 더 시간을 제한한다.

/** 백엔드 worst case(fetch 120초 + push 120초 + 로컬 작업)보다 넉넉한 상한 */
export const IPC_TIMEOUT_MS = 5 * 60_000;

/** ms 안에 끝나지 않으면 거부한다. 원본 promise의 늦은 결과는 버려진다. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(`${label} 시간 초과 — ${Math.round(ms / 1000)}초 안에 응답이 없습니다`),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** 자동 동기화 재시도 간격: 연속 실패마다 2배, 8배 상한 */
export function autoSyncDelayMs(baseMs: number, consecutiveFailures: number): number {
  return baseMs * Math.min(2 ** consecutiveFailures, 8);
}

/** 백오프를 반영해 이번 틱에 자동 동기화를 시도할지 결정한다 */
export function shouldAutoSync(
  nowMs: number,
  lastAttemptMs: number | null,
  baseMs: number,
  consecutiveFailures: number,
): boolean {
  if (lastAttemptMs === null) return true;
  return nowMs - lastAttemptMs >= autoSyncDelayMs(baseMs, consecutiveFailures);
}
