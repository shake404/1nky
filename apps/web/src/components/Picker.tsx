import { useEffect, useState } from 'react';

/**
 * The canonicalizing-combobox shape shared by every "type it, we'll fold it"
 * facet field: the "Where" city picker and the region picker are the same
 * interaction wearing two different datasets, so the interaction lives here
 * exactly once.
 *
 * What every caller gets, generic over the item type `T`:
 *   - a controlled text box that emits `canonicalize(query)` on every
 *     keystroke, so the value the parent holds is never a surprise sprung at
 *     submit time;
 *   - a dropdown of `search(query)` results, walkable with the arrow keys and
 *     takeable with Enter/Tab/click;
 *   - Escape dismisses the list without touching the field;
 *   - a hint line under the box that names the thing the current text will
 *     land on (or explains that nothing is picked yet), via `renderHint`.
 *
 * What it deliberately does NOT do: restrict. Nothing here refuses a query
 * that matches no `T` — the emitted value is always `canonicalize(query)`,
 * matched or not. A caller who wants a hard-restricted picker needs a
 * different component; this one only folds nicknames onto one slug.
 */
export interface PickerProps<T> {
  /** The canonical slug the field is holding. Always already normalised. */
  value: string;
  onChange: (value: string) => void;
  /** The one function every keystroke and every pick goes through. */
  canonicalize: (input: string) => string;
  /** Suggestions for the raw text currently in the box. */
  search: (query: string) => readonly T[];
  /** The item a canonical slug resolves to, or null when nothing carries it. */
  find: (slug: string) => T | null;
  /** The slug a taken item emits. */
  itemSlug: (item: T) => string;
  /** The contents of one menu row. */
  renderOption: (item: T) => JSX.Element;
  /** The help line under the box: the resolved item, or null when the current text matches nothing. */
  renderHint: (known: T | null) => JSX.Element;
  /** Called (at most once per mount) the first time the box is focused — the hook for a lazily-fetched dataset. */
  onWake?: () => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  maxLength?: number;
  /** Root element class, e.g. `wall-picker` or `region-picker`. */
  className: string;
  /** Suffix for the generated listbox id: `${id}-${listName}`. */
  listName: string;
}

export function Picker<T>({
  value,
  onChange,
  canonicalize,
  search,
  find,
  itemSlug,
  renderOption,
  renderHint,
  onWake,
  placeholder,
  disabled,
  id,
  maxLength,
  className,
  listName,
}: PickerProps<T>): JSX.Element {
  /** What is in the box. Kept apart from `value` so typing feels like typing. */
  const [query, setQuery] = useState(value);
  const [selected, setSelected] = useState(-1);
  const [focused, setFocused] = useState(false);
  /** Set by Escape or by taking an item; cleared on the next keystroke. */
  const [dismissed, setDismissed] = useState(false);

  // A parent that resets the field (after a post goes up) must clear the box.
  // Guarded on the query still meaning something, because a half-typed `!`
  // also canonicalizes to '' — without the guard, typing punctuation would
  // erase the field under the writer's hands.
  useEffect(() => {
    if (value === '') setQuery((current) => (canonicalize(current) === '' ? current : ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const matches = dismissed ? [] : search(query);
  const open = focused && matches.length > 0;

  const emit = (next: string): void => {
    setQuery(next);
    // Canonicalized every keystroke rather than at submit, so the value the
    // post will carry is never a surprise sprung at the end.
    onChange(canonicalize(next));
  };

  const take = (item: T): void => {
    setDismissed(true);
    setSelected(-1);
    const slug = itemSlug(item);
    setQuery(slug);
    onChange(slug);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (!open) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setSelected((i) => (i + 1) % matches.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setSelected((i) => (i <= 0 ? matches.length - 1 : i - 1));
        break;
      case 'Enter':
      case 'Tab': {
        const pick = matches[selected] ?? matches[0];
        if (pick) {
          event.preventDefault();
          take(pick);
        }
        break;
      }
      case 'Escape':
        event.preventDefault();
        setDismissed(true);
        setSelected(-1);
        break;
      default:
        break;
    }
  };

  const listId = id ? `${id}-${listName}` : undefined;
  // What the field will actually emit, and the item it turns out to be.
  const landing = canonicalize(query);
  const known = landing ? find(landing) : null;

  return (
    <div className={className}>
      <input
        id={id}
        className="input"
        value={query}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={maxLength}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        onFocus={() => {
          onWake?.();
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        onChange={(event) => {
          onWake?.();
          setDismissed(false);
          setSelected(-1);
          emit(maxLength ? event.target.value.slice(0, maxLength) : event.target.value);
        }}
        onKeyDown={onKeyDown}
      />

      {open ? (
        <ul className="picker__menu" id={listId} role="listbox">
          {matches.map((item, index) => (
            <li key={itemSlug(item)} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={index === selected}
                className={`picker__item${index === selected ? ' is-active' : ''}`}
                // Down, not click: fire before the input loses focus.
                onMouseDown={(event) => {
                  event.preventDefault();
                  take(item);
                }}
                onMouseEnter={() => setSelected(index)}
              >
                {renderOption(item)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {renderHint(known)}
    </div>
  );
}
