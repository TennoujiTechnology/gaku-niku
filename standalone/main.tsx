import React from "react";
import { createRoot } from "react-dom/client";
import { SubtitleStudio } from "../app/SubtitleStudio";
import "../app/globals.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

createRoot(root).render(
  <React.StrictMode>
    <SubtitleStudio />
  </React.StrictMode>,
);
