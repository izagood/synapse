import { translate, type Locale } from "../../i18n";

// 커밋 메시지에 로컬 시각(초 단위)을 넣어 언제 올렸는지 바로 알 수 있게 한다 (F6)
export function syncCommitMessage(now: Date = new Date(), language: Locale = "ko"): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return translate(language, "sync.commitMessage", { date, time });
}
