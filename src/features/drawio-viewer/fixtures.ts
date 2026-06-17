// drawio 뷰어/에디터의 UI 검증(Ladle 스토리 · Playwright E2E)에서 공유하는
// 샘플 mxGraph XML. mock 백엔드 시드(src/ipc/mock.ts)도 이 값을 그대로 쓴다 —
// 스토리와 E2E가 같은 입력을 보도록 한 곳에서만 정의한다.

/**
 * 도형 2개 + 엣지 1개가 있는 정상 다이어그램. vertex/edge 가 있어
 * isBlankDrawio()가 false 로 판정한다(데이터 손실 보호 대상). 색을 명시해
 * 다크 캔버스 회귀(검정-위-검정)도 스크린샷으로 드러난다.
 */
export const SAMPLE_DRAWIO_XML = `<mxfile host="synapse">
  <diagram name="Page-1" id="demo-page">
    <mxGraphModel dx="640" dy="480" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="start" value="시작" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="240" y="120" width="120" height="60" as="geometry" />
        </mxCell>
        <mxCell id="end" value="끝" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1">
          <mxGeometry x="240" y="300" width="120" height="60" as="geometry" />
        </mxCell>
        <mxCell id="edge1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;" edge="1" parent="1" source="start" target="end">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

/**
 * 도형이 하나도 없는 빈 골격. isBlankDrawio()가 true. 에디터가 로딩 중
 * 실수로 이런 빈 내용을 autosave 해도 기존 파일을 덮어쓰면 안 된다(손실 방지).
 */
export const BLANK_DRAWIO_XML = `<mxfile host="synapse">
  <diagram name="Page-1" id="blank-page">
    <mxGraphModel dx="640" dy="480" grid="1" page="1">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;
