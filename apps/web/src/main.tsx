import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing root element");
}

createRoot(root).render(
  <main>
    <h1>Tsudoi · <span lang="ja">集い</span></h1>
  </main>,
);
