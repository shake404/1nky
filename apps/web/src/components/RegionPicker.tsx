import { Picker } from './Picker.js';
import {
  canonicalRegion,
  findRegion,
  REGIONS,
  regionLabel,
  searchRegions,
  type Region,
} from '../lib/regions.js';

interface Props {
  /** The region slug going on the post. Always already slugified, or ''. */
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
}

/** Longest region slug the bundled gazetteer carries, with room spare. */
const MAX_LENGTH = 40;

/**
 * "Region" — the scene this flick belongs to, an optional facet above the
 * city.
 *
 * The city-picker's sibling: the same problem (one scene minting `bay-area`,
 * `the-bay`, `sf-bay-area` and `bay` as four feeds), the same fix (a
 * typeahead that folds nicknames onto one canonical slug while leaving an
 * unrecognised scene exactly as typed), and the same "goes up on X" hint —
 * just over the ~90-scene region gazetteer instead of the ~2.5k-city wall
 * list.
 *
 * It differs from {@link WallPicker} in exactly the ways the two datasets
 * differ, and nowhere else: the region list is bundled (no fetch, no
 * `onWake`) because it is small enough to ship, and the field itself is
 * optional (leaving it blank is a real answer, not an unrecognised scene).
 * Both wrap the same generic {@link Picker}, which is where the combobox
 * mechanics actually live.
 */
export function RegionPicker({ value, onChange, placeholder, disabled, id }: Props): JSX.Element {
  return (
    <Picker<Region>
      id={id}
      className="region-picker"
      listName="regions"
      value={value}
      onChange={onChange}
      placeholder={placeholder ?? 'Start typing a scene'}
      disabled={disabled}
      maxLength={MAX_LENGTH}
      canonicalize={canonicalRegion}
      search={(query) => searchRegions(REGIONS, query)}
      find={(slug) => findRegion(REGIONS, slug)}
      itemSlug={(region) => region.slug}
      renderOption={(region) => <span className="picker__name">{region.name}</span>}
      renderHint={(known) =>
        known ? (
          <p className="help">
            Goes up on <strong>{regionLabel(known)}</strong>.
          </p>
        ) : (
          <p className="help">Optional. Leave blank to skip a scene.</p>
        )
      }
    />
  );
}
