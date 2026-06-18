import "katex/dist/katex.min.css";
import "uno.css";

import { createRoot } from "react-dom/client";

import App from "./App";
import { AppProviders } from "./renderer/providers/AppProviders";
import "./renderer/styles/layout.css";
import "./renderer/styles/markdown.css";
import "./renderer/styles/themes/index.css";
import "./styles.css";

const rootElement = document.getElementById("app");

if (!rootElement) {
  throw new Error("应用挂载节点 #app 不存在");
}

createRoot(rootElement).render(
  <AppProviders>
    <App />
  </AppProviders>,
);
