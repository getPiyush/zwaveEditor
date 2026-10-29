import type { AppMode } from "../types";

interface Props {
  mode: AppMode;
  onChange: (mode: AppMode) => void;
}

/** Editor is the original app, untouched; Beat layers the music tools on top. */
export function ModeSwitch({ mode, onChange }: Props) {
  return (
    <div className="mode-switch" role="radiogroup" aria-label="Mode">
      <button
        type="button"
        role="radio"
        aria-checked={mode === "editor"}
        className={`mode-switch__option${mode === "editor" ? " mode-switch__option--on" : ""}`}
        onClick={() => onChange("editor")}
        title="The original editor"
      >
        Editor
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={mode === "beat"}
        className={`mode-switch__option${mode === "beat" ? " mode-switch__option--on" : ""}`}
        onClick={() => onChange("beat")}
        title="Tempo grid, snapping, master bus and the pattern maker"
      >
        Beat
      </button>
    </div>
  );
}
