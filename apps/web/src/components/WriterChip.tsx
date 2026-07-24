import { COPY, fingerprint } from '@1nky/protocol';
import { Link } from 'react-router-dom';
import { Identicon } from './Identicon.js';

interface Props {
  pubkey: string;
  name?: string | undefined;
  size?: number;
  /** Set false inside another link. */
  linked?: boolean;
}

/**
 * Tag name + mark + identicon, always together.
 *
 * Names are not unique and there is no registrar, so the mark is not
 * decoration — it is the only thing that tells two writers apart.
 */
export function WriterChip({ pubkey, name, size = 22, linked = true }: Props): JSX.Element {
  const mark = fingerprint(pubkey);
  const inner = (
    <span className="writer">
      <Identicon pubkey={pubkey} size={size} />
      <span className="writer__name">{name?.trim() || 'unnamed'}</span>
      <span className="writer__mark" title={COPY.mark.hint}>
        {mark}
      </span>
    </span>
  );

  if (!linked) return inner;
  return (
    <Link to={`/w/${pubkey}`} className="writer" aria-label={`${name ?? 'unnamed'} ${mark}`}>
      {inner}
    </Link>
  );
}
