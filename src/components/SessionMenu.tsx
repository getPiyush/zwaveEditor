import { useEffect, useRef, useState, type ReactNode } from "react";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Shown as a tooltip, e.g. why the item is disabled. */
  title?: string;
  /** Marks a toggle that is currently on (a panel that is open). */
  checked?: boolean;
  isDangerous?: boolean;
}

interface Props {
  /** Groups of items, drawn with a divider between each group. */
  groups: MenuItem[][];
  /** A line or two about the session, above the items. */
  info?: ReactNode;
}

/** The session's actions, tucked behind one button in the header. */
export function SessionMenu({ groups, info }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return (
    <div className="menu" ref={rootRef}>
      <button
        type="button"
        className={`menu__button${open ? " menu__button--open" : ""}`}
        onClick={() => setOpen((shown) => !shown)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Menu"
        title="Menu"
      >
        <MenuIcon />
      </button>

      {open && (
        <div className="menu__list" role="menu">
          {info && <div className="menu__info">{info}</div>}
          {groups.map((group, groupIndex) => (
            <div className="menu__group" role="group" key={groupIndex}>
              {group.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                  aria-checked={item.checked}
                  className={`menu__item${item.isDangerous ? " menu__item--danger" : ""}`}
                  disabled={item.disabled}
                  title={item.title}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                >
                  <span className="menu__check" aria-hidden="true">
                    {item.checked ? "✓" : ""}
                  </span>
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path d="M2 3.5h12v1.5H2zM2 7.25h12v1.5H2zM2 11h12v1.5H2z" fill="currentColor" />
    </svg>
  );
}
