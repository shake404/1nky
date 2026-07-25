import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  activeMentionQuery,
  applyMention,
  matchMentions,
  mentionHandle,
  type MentionCandidate,
} from '../lib/mentions.js';

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** The writers you can @ — the current thread/flick's participants. */
  candidates: readonly MentionCandidate[];
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  maxLength?: number;
}

/**
 * A reply box that knows the writers around it.
 *
 * Type `@` and a short list of the writers already in this thread drops down;
 * pick one and their `@tag` lands in the draft — and, because the pick is a
 * real writer and not just letters, the reply that goes up carries a reference
 * to them (see `extractMentions` + `postComment`). While that list is open the
 * arrow keys walk it and Enter takes the highlighted one instead of sending, so
 * the mention never fights the "put it up" button.
 *
 * Controlled: the draft lives with the parent, exactly like the plain
 * `<textarea>` it replaces, so wiring it in is a one-line swap.
 */
export function MentionBox({
  value,
  onChange,
  candidates,
  placeholder,
  disabled,
  id,
  maxLength,
}: Props): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  /** Set when Escape dismisses the list; cleared the moment the draft changes. */
  const [dismissed, setDismissed] = useState(false);
  /** A caret position to restore after a programmatic edit repaints. */
  const pendingCaret = useRef<number | null>(null);

  const active = activeMentionQuery(value, caret);
  const matches = active ? matchMentions(candidates, active.query) : [];
  const open = !dismissed && active !== null && matches.length > 0;

  // Keep the highlight in range as the list shrinks under a narrowing query.
  useEffect(() => {
    setSelected((current) => (current >= matches.length ? 0 : current));
  }, [matches.length]);

  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    const node = ref.current;
    if (node) {
      const at = pendingCaret.current;
      node.setSelectionRange(at, at);
      setCaret(at);
    }
    pendingCaret.current = null;
  }, [value]);

  const emit = (next: string): void => {
    onChange(maxLength === undefined ? next : next.slice(0, maxLength));
  };

  const readCaret = (node: HTMLTextAreaElement): void => {
    setCaret(node.selectionStart ?? node.value.length);
  };

  const accept = (candidate: MentionCandidate): void => {
    if (!active) return;
    const result = applyMention(value, active.start, caret, candidate);
    pendingCaret.current = result.caret;
    setDismissed(false);
    emit(result.text);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!open) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setSelected((i) => (i + 1) % matches.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setSelected((i) => (i - 1 + matches.length) % matches.length);
        break;
      case 'Enter':
      case 'Tab': {
        event.preventDefault();
        const pick = matches[selected] ?? matches[0];
        if (pick) accept(pick);
        break;
      }
      case 'Escape':
        event.preventDefault();
        setDismissed(true);
        break;
      default:
        break;
    }
  };

  const listId = id ? `${id}-mentions` : undefined;

  return (
    <div className="mention-box">
      <textarea
        ref={ref}
        id={id}
        className="textarea"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        onChange={(event) => {
          setDismissed(false);
          readCaret(event.target);
          emit(event.target.value);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={(event) => readCaret(event.currentTarget)}
        onClick={(event) => readCaret(event.currentTarget)}
        onSelect={(event) => readCaret(event.currentTarget)}
      />
      {open ? (
        <ul className="mention-menu" id={listId} role="listbox">
          {matches.map((candidate, index) => (
            <li key={candidate.pubkey} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={index === selected}
                className={`mention-menu__item${index === selected ? ' is-active' : ''}`}
                // Down, not click: fire before the textarea loses focus.
                onMouseDown={(event) => {
                  event.preventDefault();
                  accept(candidate);
                }}
                onMouseEnter={() => setSelected(index)}
              >
                <span className="mention-menu__name">@{mentionHandle(candidate)}</span>
                <span className="mention-menu__mark mono faint">{candidate.mark}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
