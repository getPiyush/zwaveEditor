import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from "react";

/** Below this many pixels a press on a handle is a click, not a drag. */
const DRAG_THRESHOLD = 3;
/** How close to the scroller's edge a drag starts scrolling it. */
const SCROLL_EDGE = 28;
const SCROLL_SPEED = 10;

/** `slot` is the gap to drop into: 0 is above the first item, `list.length` below the last. */
export function moveItem<T>(list: T[], from: number, slot: number): T[] {
  const to = slot > from ? slot - 1 : slot;
  if (from < 0 || from >= list.length || to === from) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** The nearest scroller, which may be the element itself. */
function scroller(element: HTMLElement): HTMLElement | null {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}

/** The gap nearest to `y`, going by the middle of each item as it stands now. */
function slotAt(container: HTMLElement, y: number): number {
  const items = Array.from(container.children);
  const below = items.findIndex((item) => {
    const rect = item.getBoundingClientRect();
    return y < rect.top + rect.height / 2;
  });
  return below < 0 ? items.length : below;
}

/**
 * Drag-to-arrange for the direct children of `container`, by a handle on each.
 * Uses pointer events because the webview's native drag and drop swallows HTML
 * drag events. Arrow keys on a focused handle move its item too.
 */
export function useReorder(
  container: RefObject<HTMLElement | null>,
  count: number,
  onReorder: (from: number, slot: number) => void,
) {
  const [drag, setDrag] = useState<{ from: number; slot: number } | null>(null);
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const endDrag = useRef<(() => void) | null>(null);

  useEffect(() => () => endDrag.current?.(), []);

  const start = useCallback(
    (event: ReactPointerEvent<HTMLElement>, from: number) => {
      const element = container.current;
      if (event.button !== 0 || !element) return;
      event.preventDefault();

      const scrolling = scroller(element);
      const startY = event.clientY;
      let y = startY;
      let slot: number | null = null;
      let frame = 0;

      // Runs every frame, not just on moves, so holding at the edge keeps scrolling.
      const tick = () => {
        frame = requestAnimationFrame(tick);
        if (slot === null && Math.abs(y - startY) < DRAG_THRESHOLD) return;
        if (scrolling) {
          const rect = scrolling.getBoundingClientRect();
          if (y < rect.top + SCROLL_EDGE) scrolling.scrollTop -= SCROLL_SPEED;
          else if (y > rect.bottom - SCROLL_EDGE) scrolling.scrollTop += SCROLL_SPEED;
        }
        const next = slotAt(element, y);
        if (next !== slot) {
          slot = next;
          setDrag({ from, slot: next });
        }
      };

      const onMove = (move: PointerEvent) => {
        y = move.clientY;
      };
      const finish = () => {
        cancelAnimationFrame(frame);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", finish);
        window.removeEventListener("keydown", onKey, true);
        endDrag.current = null;
        setDrag(null);
      };
      const onUp = () => {
        const dropped = slot;
        finish();
        if (dropped !== null) onReorderRef.current(from, dropped);
      };
      const onKey = (key: globalThis.KeyboardEvent) => {
        if (key.key !== "Escape") return;
        key.stopPropagation();
        finish();
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", finish);
      window.addEventListener("keydown", onKey, true);
      endDrag.current = finish;
      frame = requestAnimationFrame(tick);
    },
    [container],
  );

  /** Spread onto the handle of the item at `index`. */
  const handleProps = (index: number) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => start(event, index),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "ArrowUp" && index > 0) {
        event.preventDefault();
        onReorder(index, index - 1);
      } else if (event.key === "ArrowDown" && index < count - 1) {
        event.preventDefault();
        onReorder(index, index + 2);
      }
    },
  });

  /** Classes for the item at `index`: dimmed while dragged, a line where it would land. */
  const itemClass = (index: number): string => {
    if (!drag) return "";
    if (index === drag.from) return " reorder--dragging";
    // The gaps either side of the dragged item would leave it where it is.
    if (drag.slot === drag.from || drag.slot === drag.from + 1) return "";
    if (index === drag.slot) return " reorder--before";
    return drag.slot === count && index === count - 1 ? " reorder--after" : "";
  };

  return { handleProps, itemClass };
}
