// The rail's settings: a gear at the rail's foot opening a small menu above it, for now the look alone, three choices
// (Automatic, the device's; Light; Dark), the current one checked. A choice applies at once and closes the menu; Esc,
// Tab, or a click or tap beside it closes it too, and Esc and Tab put the focus back on the gear. Opened, the
// focus moves to the current choice; ↑↓ move among the choices (wrapping), Home and End to their ends, Enter or Space
// chooses. The menu is a WAI-ARIA menu of radio items, so a screen reader hears which look is on.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "./icons.tsx";
import { THEME_CHOICES, type ThemeChoice } from "./theme.ts";
import "./settings.css";

export function Settings({ choice, onChoose }: { choice: ThemeChoice; onChoose: (choice: ThemeChoice) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const gear = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) gear.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    // Caught before anything else hears it, so Esc closes this menu alone (not the phone's list of pages around it).
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      setOpen(false);
      gear.current?.focus();
    };
    addEventListener("pointerdown", away);
    addEventListener("keydown", escape, true);
    return () => {
      removeEventListener("pointerdown", away);
      removeEventListener("keydown", escape, true);
    };
  }, [open]);

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    // Tab leaves the menu as Esc does, back on the gear, rather than losing the focus with the menu.
    if (event.key === "Tab") return void (event.preventDefault(), close(true));
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    // Handled here, so the rail's own ↑↓ (Console.tsx's arrows) leave it be.
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const to = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[to]?.focus();
  };

  return (
    <div ref={box} className="console__settings-box">
      <button
        ref={gear}
        type="button"
        className="console__settings"
        aria-label="Settings"
        title="Settings"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((was) => !was)}
        data-nav
      >
        <Icon name="settings" />
      </button>
      {open && (
        <div ref={menu} id={menuId} className="console__menu" role="menu" aria-label="Settings" onKeyDown={onMenuKey}>
          <div className="console__menu-head" role="presentation">Look</div>
          <div role="group" aria-label="Look">
            {THEME_CHOICES.map((option) => (
              <button
                key={option.key}
                type="button"
                role="menuitemradio"
                aria-checked={option.key === choice}
                tabIndex={option.key === choice ? 0 : -1}
                className="console__menu-item"
                onClick={() => (onChoose(option.key), close(true))}
              >
                <Icon name={option.icon} />
                <span>{option.label}</span>
                {option.key === choice && <Icon name="check" className="console__menu-check" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
