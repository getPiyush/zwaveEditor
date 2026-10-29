import { useState } from "react";

import { pickDirectory } from "../lib/api";
import type { WorkspaceInfo } from "../types";

interface Props {
  workspace: WorkspaceInfo | null;
  /** Points the workspace at a folder, or back at the default with null. */
  onChange: (path: string | null) => Promise<void>;
}

/** Shows where the workspace is, and lets the user move it. */
export function WorkspaceBar({ workspace, onChange }: Props) {
  const [error, setError] = useState<string | null>(null);

  const change = async (pick: () => Promise<string | null | undefined>) => {
    try {
      setError(null);
      const path = await pick();
      if (path !== undefined) await onChange(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="workspace">
      <div className="workspace__row">
        <span className="workspace__label">Workspace{workspace?.isDefault ? " (default)" : ""}</span>
        <span className="workspace__path" title={workspace?.path}>
          {workspace?.path ?? "—"}
        </span>
      </div>
      <div className="workspace__row">
        {/* A cancelled picker changes nothing. */}
        <button
          type="button"
          className="btn btn--small"
          onClick={() => void change(async () => (await pickDirectory()) ?? undefined)}
        >
          Change…
        </button>
        {workspace && !workspace.isDefault && (
          <button
            type="button"
            className="btn btn--small"
            onClick={() => void change(async () => null)}
            title={workspace.defaultPath}
          >
            Use default
          </button>
        )}
      </div>
      {error && <p className="workspace__error">{error}</p>}
    </div>
  );
}
