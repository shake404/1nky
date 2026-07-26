import { useEffect, useRef, useState } from 'react';

import {
  canonicalWall,
  findWall,
  loadWalls,
  searchWalls,
  wallLabel,
  type Wall,
} from '../lib/walls.js';

interface Props {
  /** The wall slug going on the post. Always already slugified. */
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
}

/**
 * Longest wall slug anybody can type.
 *
 * The old free-text box capped at 32, which is shorter than real cities:
 * `santo-domingo-de-los-colorados` is 30 and would have been truncated into a
 * wall of its own. 40 clears the longest slug in the dataset with room spare.
 */
const MAX_LENGTH = 40;

/**
 * "Where" — pick the city this went up in.
 *
 * The problem it solves: this used to be a free-text box, so San Francisco was
 * four walls (`sf`, `sf-bay`, `san-francisco`, `frisco`) with four feeds and
 * nobody in any of them. Now the box suggests real cities and folds the
 * nicknames onto one slug.
 *
 * What it deliberately does NOT do is restrict. Two reasons. A writer in a town
 * of forty thousand is not going to be in any curated list, and telling them
 * their city is not a valid option is exactly the gatekeeping this place is
 * supposed to be free of. And a wall can already be named by typing a URL
 * (`/b/<anything>/new`), so a locked-down dropdown here would be a promise the
 * rest of the app does not keep. So: the list canonicalizes, it does not police.
 * Anything unrecognised is kept as typed, and a writer who types a nickname is
 * told in words which wall it is going to land on.
 *
 * The city list is fetched from our own origin the first time somebody opens
 * this, never before, and there is no geocoding call anywhere in it — a
 * typeahead that phoned a third party would hand them the one thing this project
 * promises not to collect.
 */
export function WallPicker({ value, onChange, placeholder, disabled, id }: Props): JSX.Element {
  const [walls, setWalls] = useState<readonly Wall[]>([]);
  /** What is in the box. Kept apart from `value` so typing feels like typing. */
  const [query, setQuery] = useState(value);
  const [selected, setSelected] = useState(-1);
  const [focused, setFocused] = useState(false);
  /** Set by Escape or by taking a wall; cleared on the next keystroke. */
  const [dismissed, setDismissed] = useState(false);
  const asked = useRef(false);

  // A parent that resets the field (after a post goes up) must clear the box.
  // Guarded on the query still meaning something, because a half-typed `!` also
  // canonicalizes to '' — without the guard, typing punctuation would erase the
  // field under the writer's hands.
  useEffect(() => {
    if (value === '') setQuery((current) => (canonicalWall(current) === '' ? current : ''));
  }, [value]);

  /**
   * Fetched on first use, not on mount: a writer who never names a city never
   * pays for the dataset, the same bargain the face-blur runtime makes.
   */
  const wake = (): void => {
    if (asked.current) return;
    asked.current = true;
    void loadWalls().then(setWalls);
  };

  const matches = dismissed ? [] : searchWalls(walls, query);
  const open = focused && matches.length > 0;

  const emit = (next: string): void => {
    setQuery(next);
    // Canonicalized every keystroke rather than at submit, so the wall the post
    // will carry is never a surprise sprung at the end.
    onChange(canonicalWall(next));
  };

  const take = (wall: Wall): void => {
    setDismissed(true);
    setSelected(-1);
    setQuery(wall.slug);
    onChange(wall.slug);
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

  const listId = id ? `${id}-walls` : undefined;
  // What the post will actually be tagged with, and the city it turns out to be.
  const landing = canonicalWall(query);
  const known = landing ? findWall(walls, landing) : null;

  return (
    <div className="wall-picker">
      <input
        id={id}
        className="input"
        value={query}
        placeholder={placeholder ?? 'Start typing a city'}
        disabled={disabled}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        onFocus={() => {
          wake();
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        onChange={(event) => {
          wake();
          setDismissed(false);
          setSelected(-1);
          emit(event.target.value.slice(0, MAX_LENGTH));
        }}
        onKeyDown={onKeyDown}
      />

      {open ? (
        <ul className="wall-picker__menu" id={listId} role="listbox">
          {matches.map((wall, index) => (
            <li key={wall.slug} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={index === selected}
                className={`wall-picker__item${index === selected ? ' is-active' : ''}`}
                // Down, not click: fire before the input loses focus.
                onMouseDown={(event) => {
                  event.preventDefault();
                  take(wall);
                }}
                onMouseEnter={() => setSelected(index)}
              >
                <span className="wall-picker__name">{wall.name}</span>
                <span className="wall-picker__where faint">{regionOf(wall)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {known ? (
        <p className="help">
          {/* Naming the city back is the whole point when the writer typed a
              nickname: "sf" quietly becoming san-francisco would otherwise
              look like the box eating their input. */}
          Goes up on <strong>{wallLabel(known)}</strong>.
        </p>
      ) : (
        <p className="help">
          City-granularity only — never a spot. Leave blank to put it up on the
          whole wall.
        </p>
      )}
    </div>
  );
}

/** The line beside a city's name in the menu: region, then country. */
function regionOf(wall: Wall): string {
  return wall.region ? `${wall.region} · ${wall.country}` : wall.country;
}
