// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DocumentTabs, type DocumentTabView } from "../src/DocumentTabs";

const groups: DocumentTabView[] = [
  { key: "lesson:one", label: "Statistics lessons", count: 3, collection: true, active: true, dirty: false, pinned: true },
  { key: "notebook:two", label: "analysis.bln", count: 1, collection: false, active: false, dirty: true, pinned: false },
];

let host: HTMLDivElement | null = null;

beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });

afterEach(() => {
  host?.remove();
  host = null;
});

function renderTabs(overrides: Partial<Parameters<typeof DocumentTabs>[0]> = {}) {
  host = document.createElement("div");
  document.body.append(host);
  const props: Parameters<typeof DocumentTabs>[0] = {
    groups,
    workspaceName: "Research",
    canReopen: false,
    onWorkspaceNameChange: vi.fn(),
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onPin: vi.fn(),
    onMove: vi.fn(),
    onCloseOthers: vi.fn(),
    onCloseToRight: vi.fn(),
    onNew: vi.fn(),
    onReopen: vi.fn(),
    ...overrides,
  };
  const root = createRoot(host);
  act(() => root.render(<DocumentTabs {...props}/>));
  return { props, root };
}

describe("document tabs", () => {
  it("exposes tab actions without requiring users to discover right-click", () => {
    const onPin = vi.fn();
    const { root } = renderTabs({ onPin });
    const actions = host!.querySelector<HTMLButtonElement>('[aria-label="Actions for analysis.bln"]')!;
    act(() => actions.click());
    expect(host!.querySelector('[role="menu"]')?.textContent).toContain("Pin tab");
    const pin = [...host!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent === "Pin tab")!;
    act(() => pin.click());
    expect(onPin).toHaveBeenCalledWith("notebook:two", true);
    act(() => root.unmount());
  });

  it("supports arrow-key tab switching and shows every tab in the overflow chooser", () => {
    const onSelect = vi.fn();
    const { root } = renderTabs({ onSelect });
    const active = host!.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!;
    act(() => active.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(onSelect).toHaveBeenCalledWith("notebook:two");
    expect(host!.querySelector(".tab-overflow")?.textContent).toContain("analysis.bln");
    act(() => root.unmount());
  });
});
