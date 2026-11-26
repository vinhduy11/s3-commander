// The path text of a panel header. A click (or Cmd/Ctrl+L, handled by the panel) turns it into an
// input: Enter navigates, Esc and blur cancel. A recent-locations listbox opens under the input.

import { useId, useLayoutEffect, useRef, useState } from "react";
import { useBrowseStore, type Side } from "./browse_store";
import { goToLocation, recentsFor } from "./go_to_flow";

type Props = { side: Side; editing: boolean; onEditingChange: (editing: boolean, refocusPanel?: boolean) => void };

export function PathField({ side, editing, onEditingChange }: Props) {
  const { source, path } = useBrowseStore((state) => state[side]);
  const shown = source?.kind === "bucket" ? `/${path}` : path;
  if (editing) return <PathEditor side={side} onEditingChange={onEditingChange} />;
  return (
    <button type="button" className="path" title={`${path || "Home"}\nClick or press Ctrl/Cmd+L to type a path`} onClick={() => onEditingChange(true)}>
      {shown}
    </button>
  );
}

function PathEditor({ side, onEditingChange }: Pick<Props, "side" | "onEditingChange">) {
  const { source, path } = useBrowseStore.getState()[side];
  const [text, setText] = useState(source?.kind === "bucket" ? `s3://${source.bucket}/${path}` : path);
  const [recents] = useState(() => recentsFor(side));
  const [highlight, setHighlight] = useState(-1);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const optionId = (index: number) => `${listId}-${index}`;

  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  async function submit(value: string) {
    const message = await goToLocation(side, value);
    if (message) setError(message);
    else onEditingChange(false, true);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    event.stopPropagation(); // the panel's own keys (Backspace goes up, Enter opens a row) must not see typing
    if (event.key === "Escape") onEditingChange(false, true);
    else if (event.key === "Enter") void submit(highlight >= 0 ? recents[highlight] : text);
    else if (event.key === "ArrowDown") setHighlight((index) => Math.min(index + 1, recents.length - 1));
    else if (event.key === "ArrowUp") setHighlight((index) => Math.max(index - 1, -1));
    else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") inputRef.current?.select();
    else return;
    if (event.key !== "Tab") event.preventDefault();
  }

  return (
    <span className="path-edit">
      <input
        ref={inputRef}
        className="path-input"
        type="text"
        role="combobox"
        aria-label={`Path of the ${side} panel`}
        aria-autocomplete="list"
        aria-expanded={recents.length > 0}
        aria-controls={recents.length ? listId : undefined}
        aria-activedescendant={highlight >= 0 ? optionId(highlight) : undefined}
        aria-invalid={error ? true : undefined}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        value={text}
        onChange={(event) => {
          setText(event.currentTarget.value);
          setError("");
          setHighlight(-1);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => onEditingChange(false)}
      />
      <span className="path-pop">
        {error && <span className="path-error" role="alert">{error}</span>}
        {recents.length > 0 && (
          <span className="path-recents" role="listbox" id={listId} aria-label="Recent locations">
            {recents.map((recent, index) => (
              <span
                key={recent}
                id={optionId(index)}
                role="option"
                aria-selected={index === highlight}
                className={`path-recent${index === highlight ? " on" : ""}`}
                onMouseDown={(event) => event.preventDefault()} // keep the input focused: blur would cancel before the click
                onClick={() => void submit(recent)}
              >
                {recent}
              </span>
            ))}
          </span>
        )}
      </span>
    </span>
  );
}
