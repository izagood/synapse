import { beforeEach, describe, expect, it } from "vitest";
import { useAgent } from "./agent";
import { mockAgentControl } from "../ipc/mock";

const ROOT = "/mock/notes";

/** mock이 queueMicrotask로 흘려보낸 이벤트가 모두 처리될 때까지 대기 */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("agent store (mock ipc)", () => {
  beforeEach(() => {
    mockAgentControl.installed = true;
    mockAgentControl.script = null;
    mockAgentControl.lastSend = null;
    mockAgentControl.running = false;
    useAgent.setState({
      status: null,
      items: [],
      running: false,
      runId: null,
      sessionId: null,
      root: null,
      askNotes: false,
      pendingSources: null,
    });
  });

  it("init은 CLI 상태를 채운다", async () => {
    await useAgent.getState().init(ROOT);
    expect(useAgent.getState().status?.installed).toBe(true);
    expect(useAgent.getState().root).toBe(ROOT);
  });

  it("CLI 미설치면 installed=false", async () => {
    mockAgentControl.installed = false;
    await useAgent.getState().init(ROOT);
    expect(useAgent.getState().status?.installed).toBe(false);
  });

  it("send: 사용자 메시지 추가 → 응답 스트림 반영 → 세션 저장", async () => {
    await useAgent.getState().init(ROOT);
    await useAgent.getState().send(ROOT, "안녕");
    expect(useAgent.getState().running).toBe(true);
    expect(useAgent.getState().items[0]).toMatchObject({ role: "user", text: "안녕" });

    await flush();
    const s = useAgent.getState();
    expect(s.running).toBe(false);
    expect(s.items.map((i) => i.role)).toEqual(["user", "assistant"]);
    expect(s.items[1].text).toBe("mock 응답: 안녕");
    expect(s.sessionId).toBe("mock-session");
  });

  it("다음 send는 저장된 세션으로 이어간다(--resume)", async () => {
    await useAgent.getState().init(ROOT);
    await useAgent.getState().send(ROOT, "첫 질문");
    await flush();
    await useAgent.getState().send(ROOT, "이어지는 질문");
    expect(mockAgentControl.lastSend?.sessionId).toBe("mock-session");
    await flush();
  });

  it("toolUse 이벤트는 도구 사용 줄로 표시된다", async () => {
    mockAgentControl.script = [
      { kind: "started", sessionId: "s1", model: "m" },
      { kind: "toolUse", name: "Read", detail: "README.md" },
      { kind: "text", text: "읽었습니다" },
      { kind: "completed", ok: true, result: "읽었습니다", sessionId: "s1", costUsd: 0, numTurns: 1 },
    ];
    await useAgent.getState().init(ROOT);
    await useAgent.getState().send(ROOT, "README 읽어줘");
    await flush();
    const roles = useAgent.getState().items.map((i) => i.role);
    expect(roles).toEqual(["user", "tool", "assistant"]);
    expect(useAgent.getState().items[1].text).toBe("Read · README.md");
  });

  it("failed 이벤트는 에러 메시지로 표시되고 running이 풀린다", async () => {
    mockAgentControl.script = [{ kind: "failed", message: "claude가 비정상 종료했습니다" }];
    await useAgent.getState().init(ROOT);
    await useAgent.getState().send(ROOT, "x");
    await flush();
    const s = useAgent.getState();
    expect(s.running).toBe(false);
    expect(s.items[1]).toMatchObject({ role: "error", text: "claude가 비정상 종료했습니다" });
  });

  it("stop: aborted 이벤트로 마감된다", async () => {
    // completed 없이 시작만 하는 스크립트 → 실행 중 상태 유지
    mockAgentControl.script = [{ kind: "started", sessionId: "s1", model: "m" }];
    await useAgent.getState().init(ROOT);
    await useAgent.getState().send(ROOT, "긴 작업");
    await flush();
    expect(useAgent.getState().running).toBe(true);

    mockAgentControl.running = true; // mock에선 스크립트 소진 후 풀리므로 강제로 실행 중 취급
    await useAgent.getState().stop();
    const s = useAgent.getState();
    expect(s.running).toBe(false);
    expect(s.items.at(-1)).toMatchObject({ role: "info" });
  });

  it("다른 runId의 이벤트는 무시한다", async () => {
    await useAgent.getState().init(ROOT);
    useAgent.setState({ runId: "current-run", running: true });
    useAgent.getState().applyEvent("other-run", { kind: "text", text: "유령 메시지" });
    expect(useAgent.getState().items).toHaveLength(0);
    expect(useAgent.getState().running).toBe(true);
  });

  it("send 자체가 실패하면 에러 항목을 남기고 running을 푼다", async () => {
    mockAgentControl.installed = false;
    await useAgent.getState().init(ROOT);
    await useAgent.getState().send(ROOT, "x");
    const s = useAgent.getState();
    expect(s.running).toBe(false);
    expect(s.items.map((i) => i.role)).toEqual(["user", "error"]);
  });

  it("newConversation은 대화와 세션을 비운다 (실행 중엔 무시)", async () => {
    await useAgent.getState().init(ROOT);
    await useAgent.getState().send(ROOT, "안녕");
    await flush();
    expect(useAgent.getState().sessionId).toBe("mock-session");

    useAgent.setState({ running: true });
    useAgent.getState().newConversation();
    expect(useAgent.getState().sessionId).toBe("mock-session"); // 실행 중엔 무시

    useAgent.setState({ running: false });
    useAgent.getState().newConversation();
    const s = useAgent.getState();
    expect(s.items).toHaveLength(0);
    expect(s.sessionId).toBeNull();
  });

  it("워크스페이스가 바뀌면 대화를 비운다", async () => {
    await useAgent.getState().init(ROOT);
    await useAgent.getState().send(ROOT, "안녕");
    await flush();
    expect(useAgent.getState().items.length).toBeGreaterThan(0);

    await useAgent.getState().init("/mock/other");
    expect(useAgent.getState().items).toHaveLength(0);
    expect(useAgent.getState().root).toBe("/mock/other");
  });

  it("askNotes 모드: 관련 노트를 retrieval해 출처를 답변에 붙이고 프롬프트에 컨텍스트를 넣는다", async () => {
    await useAgent.getState().init(ROOT);
    useAgent.getState().setAskNotes(true);
    // mock README에 "브라우저 개발 모드" 문구가 있다 → retrieval이 출처를 찾는다
    await useAgent.getState().send(ROOT, "브라우저 개발 모드가 뭐야");
    await flush();

    const s = useAgent.getState();
    const assistant = s.items.find((i) => i.role === "assistant");
    expect(assistant?.sources?.length).toBeGreaterThan(0);
    // 출처는 절대 경로 + 상대 경로를 갖는다
    expect(assistant?.sources?.[0].path.startsWith(ROOT)).toBe(true);
    expect(assistant?.sources?.[0].relPath).not.toContain(ROOT);
    // CLI로 보낸 프롬프트엔 출처 컨텍스트가 들어간다 (채팅 표시는 원본 질문)
    expect(mockAgentControl.lastSend?.prompt).toContain("[출처:");
    expect(s.items.find((i) => i.role === "user")?.text).toBe("브라우저 개발 모드가 뭐야");
    // 응답이 끝나면 pendingSources는 비워진다
    expect(s.pendingSources).toBeNull();
  });

  it("askNotes 모드라도 관련 노트가 없으면 출처 없이 원본 질문을 보낸다", async () => {
    await useAgent.getState().init(ROOT);
    useAgent.getState().setAskNotes(true);
    await useAgent.getState().send(ROOT, "zzzqqqxnomatch");
    await flush();
    const assistant = useAgent.getState().items.find((i) => i.role === "assistant");
    expect(assistant?.sources).toBeUndefined();
    expect(mockAgentControl.lastSend?.prompt).toBe("zzzqqqxnomatch");
  });

  it("askNotes를 끄면 일반(열린 노트 경로) 컨텍스트로 보낸다", async () => {
    await useAgent.getState().init(ROOT);
    useAgent.getState().setAskNotes(false);
    await useAgent.getState().send(ROOT, "안녕");
    await flush();
    expect(mockAgentControl.lastSend?.prompt).not.toContain("[출처:");
  });

  it("응답 도중 stop 없이 두 번째 send는 무시된다", async () => {
    mockAgentControl.script = [{ kind: "started", sessionId: "s1", model: "m" }];
    await useAgent.getState().init(ROOT);
    await useAgent.getState().send(ROOT, "첫 번째");
    await flush();
    await useAgent.getState().send(ROOT, "두 번째");
    expect(useAgent.getState().items.filter((i) => i.role === "user")).toHaveLength(1);
    expect(mockAgentControl.lastSend?.prompt).toBe("첫 번째");
  });
});
