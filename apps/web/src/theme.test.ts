import { afterEach, expect, it, vi } from "vitest";
import { applyThemePreference, watchSystemTheme } from "./theme";

afterEach(() => vi.unstubAllGlobals());

function environment(blockStorage = false) {
  const dataset: Record<string, string> = { themePreference: "system" };
  const media = {
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const storage = {
    setItem: vi.fn(() => {
      if (blockStorage) throw new Error("Storage blocked");
    }),
    removeItem: vi.fn(() => {
      if (blockStorage) throw new Error("Storage blocked");
    }),
  };
  vi.stubGlobal("document", { documentElement: { dataset } });
  vi.stubGlobal("window", { matchMedia: () => media, localStorage: storage });
  return { dataset, media, storage };
}

it("applies every preference even when storage operations throw", () => {
  const { dataset, media } = environment(true);
  for (const choice of ["light", "dark", "system"] as const) {
    expect(() => applyThemePreference(choice)).not.toThrow();
    expect(dataset.themePreference).toBe(choice);
    expect(dataset.theme).toBe(choice === "system" ? "light" : choice);
  }
  media.matches = true;
  applyThemePreference("system");
  expect(dataset.theme).toBe("dark");
});

it("keeps the existing preference key and removes it for System", () => {
  const { storage } = environment();
  applyThemePreference("dark");
  expect(storage.setItem).toHaveBeenCalledWith("voxelspy-theme", "dark");
  applyThemePreference("system");
  expect(storage.removeItem).toHaveBeenCalledWith("voxelspy-theme");
});

it("tracks system changes, respects explicit choices, and removes its listener", () => {
  const { dataset, media } = environment();
  const stop = watchSystemTheme();
  expect(dataset.theme).toBe("light");
  const update = media.addEventListener.mock.calls[0]![1] as () => void;
  media.matches = true;
  update();
  expect(dataset.theme).toBe("dark");
  applyThemePreference("light");
  update();
  expect(dataset.theme).toBe("light");
  applyThemePreference("system");
  media.matches = false;
  update();
  expect(dataset.theme).toBe("light");
  stop();
  expect(media.removeEventListener).toHaveBeenCalledWith("change", update);
});
