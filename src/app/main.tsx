import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// HTML5 드래그앤드롭 사용을 위해 Tauri의 dragDropEnabled를 꺼둔 상태이므로,
// 에디터 밖에 파일을 떨어뜨렸을 때 웹뷰가 그 파일로 이동해버리지 않게 막는다.
// (에디터 내부 드롭은 ProseMirror handleDrop이 먼저 처리한다)
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
