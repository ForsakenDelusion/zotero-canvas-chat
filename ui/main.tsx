import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ReactFlowProvider } from "@xyflow/react";
import { Network } from "lucide-react";
import "@xyflow/react/dist/style.css";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github.css";
import "./styles.css";
import { createBridge, type Bridge } from "./bridge";
import type { Snapshot } from "../shared/schema";
import { Workspace } from "./workspace";

const connectionRequest = createBridge();

function App() {
  const [connection, setConnection] = useState<{ bridge: Bridge; initial: Snapshot }>();
  const [error, setError] = useState("");
  useEffect(() => {
    void connectionRequest
      .then(async (bridge) => setConnection({ bridge, initial: await bridge.call({ type: "ready" }) }))
      .catch((cause: Error) => setError(cause.message));
  }, []);
  if (!connection) return (
    <main className="boot">
      <span className="brand-mark"><Network size={21} /></span>
      <h1>Canvas Chat</h1>
      <p role={error ? "alert" : "status"}>{error || "正在读取画布…"}</p>
      {error && <p>请返回 LLM for Zotero，再点一次「画布」。</p>}
    </main>
  );
  return <ReactFlowProvider><Workspace {...connection} /></ReactFlowProvider>;
}

createRoot(document.getElementById("root")!).render(<App />);
