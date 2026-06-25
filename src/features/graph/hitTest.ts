import { type Camera, worldToScreen } from "./camera";

export interface HitNode { path: string; x: number; y: number; r: number }

// 화면 반경 = 노드 반경 * 줌 + 여유 패딩. 가장 가까운(중심거리 최소) 후보를 고른다.
const HIT_PAD = 4;

export function nodeAtScreen(
  nodes: HitNode[], cam: Camera, sx: number, sy: number,
): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const n of nodes) {
    const s = worldToScreen(cam, n.x, n.y);
    const dx = s.x - sx;
    const dy = s.y - sy;
    const d2 = dx * dx + dy * dy;
    const rad = n.r * cam.k + HIT_PAD;
    if (d2 <= rad * rad && d2 < bestD) { bestD = d2; best = n.path; }
  }
  return best;
}
