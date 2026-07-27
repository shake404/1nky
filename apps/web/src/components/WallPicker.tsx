import { useRef, useState } from 'react';

import { Picker } from './Picker.js';
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
 *
 * The combobox mechanics (typeahead, canonicalize-on-keystroke, arrow keys,
 * the "goes up on X" hint) live in the generic {@link Picker}; this is a thin
 * wrapper that supplies the city dataset and its lazy fetch. See
 * `RegionPicker` for the sibling that shares the same `Picker` over the
 * bundled region gazetteer instead of the fetched city list.
 */
export function WallPicker({ value, onChange, placeholder, disabled, id }: Props): JSX.Element {
  const [walls, setWalls] = useState<readonly Wall[]>([]);
  const asked = useRef(false);

  /**
   * Fetched on first use, not on mount: a writer who never names a city never
   * pays for the dataset, the same bargain the face-blur runtime makes.
   */
  const wake = (): void => {
    if (asked.current) return;
    asked.current = true;
    void loadWalls().then(setWalls);
  };

  return (
    <Picker<Wall>
      id={id}
      className="wall-picker"
      listName="walls"
      value={value}
      onChange={onChange}
      placeholder={placeholder ?? 'Start typing a city'}
      disabled={disabled}
      maxLength={MAX_LENGTH}
      canonicalize={canonicalWall}
      search={(query) => searchWalls(walls, query)}
      find={(slug) => findWall(walls, slug)}
      itemSlug={(wall) => wall.slug}
      onWake={wake}
      renderOption={(wall) => (
        <>
          <span className="picker__name">{wall.name}</span>
          <span className="picker__meta faint">{regionOf(wall)}</span>
        </>
      )}
      renderHint={(known) =>
        known ? (
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
        )
      }
    />
  );
}

/** The line beside a city's name in the menu: region, then country. */
function regionOf(wall: Wall): string {
  return wall.region ? `${wall.region} · ${wall.country}` : wall.country;
}
