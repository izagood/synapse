/**
 * 파일 히스토리 표시용 순수 헬퍼 (FR-4.7). UI에서 분리해 단위 테스트한다.
 */

/** ISO 8601 커밋 시각을 로캘에 맞춰 사람이 읽기 좋은 문자열로 바꾼다.
 * 파싱에 실패하면 원문을 그대로 돌려준다 (앱이 죽지 않게). */
export function formatCommitTime(
  iso: string,
  locale: string,
  now: Date = new Date(),
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const intlLocale = locale === "en" ? "en-US" : "ko-KR";
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = date.toLocaleTimeString(intlLocale, {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (sameDay) return time;
  const day = date.toLocaleDateString(intlLocale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return `${day} ${time}`;
}

/** 커밋 메시지의 첫 줄만 (제목). 빈 메시지는 짧은 해시로 대체 */
export function commitTitle(message: string, shortHash: string): string {
  const firstLine = message.split("\n")[0].trim();
  return firstLine || shortHash;
}
