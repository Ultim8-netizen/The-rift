import { useEffect } from "react";
import { useRiftStore } from "@/store/riftStore";
import type { ThemeId } from "@/types";

const STORAGE_KEY = "rift-theme-v1";

function resolveTheme(id: ThemeId): string {
  if (id !== "system") return id;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark-black"
    : "light-blue";
}

export function applyTheme(id: ThemeId) {
  const root = document.documentElement;
  root.classList.add("theme-transitioning");
  root.setAttribute("data-theme", resolveTheme(id));
  setTimeout(() => root.classList.remove("theme-transitioning"), 400);
}

export function setAndPersistTheme(id: ThemeId) {
  localStorage.setItem(STORAGE_KEY, id);
  applyTheme(id);
}

export function useTheme() {
  const setTheme = useRiftStore((s) => s.setTheme);

  useEffect(() => {
    const stored = (localStorage.getItem(STORAGE_KEY) as ThemeId | null) ?? "system";
    setTheme(stored);
    applyTheme(stored);

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      const current = (localStorage.getItem(STORAGE_KEY) as ThemeId | null) ?? "system";
      if (current === "system") applyTheme("system");
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [setTheme]);
}