import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Walkdeck } from "@/components/walkdeck";
import "@/styles.css";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("./sw.js");
  });
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Walkdeck />
    </StrictMode>,
  );
}
