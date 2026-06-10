import { useEffect } from "react";
import { useWorkspace } from "../stores/workspace";
import { StartScreen } from "../features/workspace/StartScreen";
import { WorkspaceView } from "../features/workspace/WorkspaceView";

export default function App() {
  const root = useWorkspace((s) => s.root);
  const init = useWorkspace((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

  return root ? <WorkspaceView /> : <StartScreen />;
}
