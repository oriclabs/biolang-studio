import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

export interface DocumentTabView {
  key: string;
  label: string;
  count: number;
  collection: boolean;
  active: boolean;
  dirty: boolean;
  pinned: boolean;
}

interface DocumentTabsProps {
  groups: DocumentTabView[];
  workspaceName: string;
  canReopen: boolean;
  onWorkspaceNameChange: (name: string) => void;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  onPin: (key: string, pinned: boolean) => void;
  onMove: (sourceKey: string, targetKey: string) => void;
  onCloseOthers: (key: string) => void;
  onCloseToRight: (key: string) => void;
  onNew: () => void;
  onReopen: () => void;
}

type MenuState = { key: string; x: number; y: number } | null;

export function DocumentTabs(props: DocumentTabsProps) {
  const [menu, setMenu] = useState<MenuState>(null);
  const [dragging, setDragging] = useState("");
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const active = props.groups.find(group => group.active);

  useEffect(() => {
    if (!active) return;
    tabRefs.current.get(active.key)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active?.key]);

  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    const keydown = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
    addEventListener("pointerdown", dismiss);
    addEventListener("keydown", keydown);
    addEventListener("resize", dismiss);
    return () => {
      removeEventListener("pointerdown", dismiss);
      removeEventListener("keydown", keydown);
      removeEventListener("resize", dismiss);
    };
  }, [menu]);

  function openMenu(event: MouseEvent, key: string) {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ key, x: Math.max(8, Math.min(event.clientX, innerWidth - 220)), y: Math.max(8, Math.min(event.clientY, innerHeight - 285)) });
  }

  function chooseRelative(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = -1;
    if (event.key === "ArrowLeft") next = (index - 1 + props.groups.length) % props.groups.length;
    if (event.key === "ArrowRight") next = (index + 1) % props.groups.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = props.groups.length - 1;
    if (next < 0) return;
    event.preventDefault();
    props.onSelect(props.groups[next].key);
  }

  const menuGroup = menu ? props.groups.find(group => group.key === menu.key) : undefined;
  const menuIndex = menuGroup ? props.groups.findIndex(group => group.key === menuGroup.key) : -1;
  const leftGroup = menuGroup && menuIndex > 0 && props.groups[menuIndex - 1].pinned === menuGroup.pinned ? props.groups[menuIndex - 1] : undefined;
  const rightGroup = menuGroup && menuIndex >= 0 && menuIndex < props.groups.length - 1 && props.groups[menuIndex + 1].pinned === menuGroup.pinned ? props.groups[menuIndex + 1] : undefined;

  return <div className="document-tabs">
    <input aria-label="Workspace name" value={props.workspaceName} onChange={event => props.onWorkspaceNameChange(event.target.value)} />
    <div role="tablist" aria-label="Open notebooks">
      {props.groups.map((group, index) => <div
        className={`document-tab ${group.collection ? "collection" : "notebook"} ${group.pinned ? "pinned" : ""} ${group.active ? "active" : ""} ${dragging === group.key ? "dragging" : ""}`}
        data-tab-key={group.key}
        ref={element => { if (element) tabRefs.current.set(group.key, element); else tabRefs.current.delete(group.key); }}
        draggable
        key={group.key}
        onDragStart={event => { setDragging(group.key); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/x-biolang-tab", group.key); }}
        onDragEnd={() => setDragging("")}
        onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
        onDrop={event => { event.preventDefault(); const source = event.dataTransfer.getData("text/x-biolang-tab") || dragging; if (source && source !== group.key) props.onMove(source, group.key); setDragging(""); }}
        onContextMenu={event => openMenu(event, group.key)}
      >
        <button role="tab" aria-selected={group.active} tabIndex={group.active ? 0 : -1} title={group.label} onClick={() => props.onSelect(group.key)} onKeyDown={event => chooseRelative(event, index)}>
          {group.pinned && <span className="tab-pin" aria-label="Pinned" title="Pinned">◆</span>}
          <span>{group.label}</span>
          {group.collection && <b title={`${group.count} lesson sections`}>{group.count}</b>}
          {group.dirty && <i title="Unsaved changes">●</i>}
        </button>
        <button className="tab-actions" aria-label={`Actions for ${group.label}`} title="Tab actions" onClick={event => openMenu(event, group.key)}>•••</button>
        <button className="tab-close" aria-label={`Close ${group.label}`} title="Close" onClick={() => props.onClose(group.key)}>×</button>
      </div>)}
    </div>
    <details className="tab-overflow">
      <summary title="Show all open tabs" aria-label="Show all open tabs">▾ <span>{props.groups.length}</span></summary>
      <div>{props.groups.map(group => <button className={group.active ? "active" : ""} key={group.key} onClick={event => { props.onSelect(group.key); event.currentTarget.closest("details")?.removeAttribute("open"); }}><span>{group.pinned ? "◆ " : ""}{group.label}</span><small>{group.dirty ? "● " : ""}{group.collection ? `${group.count} sections` : "Notebook"}</small></button>)}</div>
    </details>
    <button title="New notebook" aria-label="New notebook" onClick={props.onNew}>＋</button>
    {props.canReopen && <button className="reopen-tab" onClick={props.onReopen}>Reopen closed</button>}
    {menu && menuGroup && <div className="tab-context-menu" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={event => event.stopPropagation()}>
      <strong>{menuGroup.label}</strong>
      <button role="menuitem" onClick={() => { props.onPin(menuGroup.key, !menuGroup.pinned); setMenu(null); }}>{menuGroup.pinned ? "Unpin tab" : "Pin tab"}</button>
      <button role="menuitem" disabled={!leftGroup} onClick={() => { if (leftGroup) props.onMove(menuGroup.key, leftGroup.key); setMenu(null); }}>Move left</button>
      <button role="menuitem" disabled={!rightGroup} onClick={() => { if (rightGroup) props.onMove(rightGroup.key, menuGroup.key); setMenu(null); }}>Move right</button>
      <button role="menuitem" onClick={() => { props.onClose(menuGroup.key); setMenu(null); }}>Close</button>
      <button role="menuitem" disabled={props.groups.length < 2} onClick={() => { props.onCloseOthers(menuGroup.key); setMenu(null); }}>Close other tabs</button>
      <button role="menuitem" disabled={menuIndex < 0 || menuIndex === props.groups.length - 1} onClick={() => { props.onCloseToRight(menuGroup.key); setMenu(null); }}>Close tabs to the right</button>
    </div>}
  </div>;
}
