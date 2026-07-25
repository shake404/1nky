import { COPY, fingerprint } from '@1nky/protocol';
import { Link } from 'react-router-dom';
import { Avatar } from './Avatar.js';

interface Props {
  pubkey: string;
  name?: string | undefined;
  /** Their chosen picture, when the byline carries one; falls back to the mark. */
  avatarSha256?: string | null;
  size?: number;
  /** Set false inside another link. */
  linked?: boolean;
}

/**
 * Tag name + mark + picture, always together.
 *
 * Names are not unique and there is no registrar, so the mark is not
 * decoration — it is the only thing that tells two writers apart. The picture
 * (their avatar when set, the block-mark when not) rides alongside it.
 */
export function WriterChip({ pubkey, name, avatarSha256, size = 22, linked = true }: Props): JSX.Element {
  const mark = fingerprint(pubkey);
  const inner = (
    <span className="writer">
      <Avatar pubkey={pubkey} avatarSha256={avatarSha256} size={size} />
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
