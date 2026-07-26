import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { KINDS, type SignedEvent } from '@1nky/protocol';
import { getPref, setPref } from '../lib/db.js';
import { decodeWrap, dmKey, sendMessage, type DecodedDm } from '../lib/dm.js';
import { relay } from '../lib/relay.js';
import { useActiveTag, useTag } from './TagProvider.js';

/**
 * The on-device message store.
 *
 * The relay is the source of truth for delivery; this is the only place
 * decrypted text is allowed to live. Incoming wraps are unwrapped here and
 * cached in IndexedDB so a reload restores a conversation without re-fetching
 * every wrap. Sent messages are recorded the moment they leave so the thread
 * updates instantly and survives a reload — the recipient cannot be recovered
 * from our own self-wrap through the frozen API, so we trust the local record.
 */

export interface StoredDm {
  key: string;
  partner: string;
  senderPubkey: string;
  text: string;
  createdAt: number;
  mine: boolean;
}

export interface ConversationSummary {
  partner: string;
  lastText: string;
  lastCreatedAt: number;
  unread: boolean;
}

interface DmContextValue {
  conversations: ConversationSummary[];
  thread: (partner: string) => StoredDm[];
  send: (partner: string, text: string) => Promise<void>;
  markRead: (partner: string) => void;
  ready: boolean;
}

const DmContext = createContext<DmContextValue | null>(null);

const CACHE_KEY = 'dm-cache';
const READ_KEY = 'dm-read';

type CacheShape = Record<string, StoredDm[]>;

function summaries(cache: CacheShape, readAt: Record<string, number>): ConversationSummary[] {
  return Object.entries(cache)
    .map(([partner, messages]): ConversationSummary | null => {
      const last = messages[messages.length - 1];
      if (!last) return null;
      return {
        partner,
        lastText: last.text,
        lastCreatedAt: last.createdAt,
        unread: messages.some((m) => !m.mine && m.createdAt > (readAt[partner] ?? 0)),
      };
    })
    .filter((c): c is ConversationSummary => c !== null)
    .sort((a, b) => b.lastCreatedAt - a.lastCreatedAt);
}

export function DmProvider({ children }: { children: ReactNode }): JSX.Element {
  // The INBOX (subscription + cache) is always the writer's own tag — a crew's
  // messages are its own inbox, not ours. Only the OUTGOING wrap is signed by
  // the active signer, so a message sent "as a crew" leaves under the crew key.
  const { tag } = useTag();
  const { active } = useActiveTag();
  const [cache, setCache] = useState<CacheShape>({});
  const [readAt, setReadAt] = useState<Record<string, number>>({});
  const [ready, setReady] = useState(false);
  const cacheRef = useRef<CacheShape>({});
  const readRef = useRef<Record<string, number>>({});

  const persist = useCallback((nextCache: CacheShape, nextReads: Record<string, number>) => {
    cacheRef.current = nextCache;
    readRef.current = nextReads;
    void setPref(CACHE_KEY, nextCache);
    void setPref(READ_KEY, nextReads);
  }, []);

  useEffect(() => {
    if (!tag) return;
    let live = true;
    void (async () => {
      const stored = await getPref<CacheShape>(CACHE_KEY, {});
      const reads = await getPref<Record<string, number>>(READ_KEY, {});
      if (!live) return;
      cacheRef.current = stored;
      readRef.current = reads;
      setCache(stored);
      setReadAt(reads);
      setReady(true);
    })();
    return () => {
      live = false;
    };
  }, [tag]);

  const upsert = useCallback(
    (message: StoredDm) => {
      setCache((current) => {
        const thread = current[message.partner] ?? [];
        if (thread.some((m) => m.key === message.key)) return current;
        const next: CacheShape = {
          ...current,
          [message.partner]: [...thread, message].sort((a, b) => a.createdAt - b.createdAt),
        };
        persist(next, readRef.current);
        return next;
      });
    },
    [persist],
  );

  // Live inbox: only incoming wraps matter here. Our own self-copies are
  // recorded locally at send time (we know the recipient then); the frozen
  // unwrap API does not expose who a self-wrap was sent to.
  useEffect(() => {
    if (!tag) return;
    const sub = relay.subscribe([{ kinds: [KINDS.GIFT_WRAP], '#p': [tag.pubkey], limit: 200 }], {
      onEvent: (wrap: SignedEvent) => {
        const decoded: DecodedDm | null = decodeWrap(tag.secret, tag.pubkey, wrap);
        if (decoded === null || decoded.mine) return;
        upsert({
          key: dmKey(decoded),
          partner: decoded.senderPubkey,
          senderPubkey: decoded.senderPubkey,
          text: decoded.text,
          createdAt: decoded.createdAt,
          mine: false,
        });
      },
    });
    return () => sub.close();
  }, [tag, upsert]);

  const send = useCallback(
    async (partner: string, text: string): Promise<void> => {
      const signer = active ?? tag;
      if (!signer) return;
      await sendMessage(signer, partner, text);
      const createdAt = Math.floor(Date.now() / 1000);
      const trimmed = text.trim();
      upsert({
        key: dmKey({ senderPubkey: signer.pubkey, createdAt, text: trimmed }),
        partner,
        senderPubkey: signer.pubkey,
        text: trimmed,
        createdAt,
        mine: true,
      });
    },
    [active, tag, upsert],
  );

  const markRead = useCallback(
    (partner: string) => {
      setReadAt((current) => {
        const next = { ...current, [partner]: Math.floor(Date.now() / 1000) };
        persist(cacheRef.current, next);
        return next;
      });
    },
    [persist],
  );

  const thread = useCallback((partner: string): StoredDm[] => cache[partner] ?? [], [cache]);

  const conversations = useMemo(() => summaries(cache, readAt), [cache, readAt]);

  const value = useMemo<DmContextValue>(
    () => ({ conversations, thread, send, markRead, ready }),
    [conversations, thread, send, markRead, ready],
  );

  return <DmContext.Provider value={value}>{children}</DmContext.Provider>;
}

export function useDms(): DmContextValue {
  const context = useContext(DmContext);
  if (!context) throw new Error('useDms must be used inside <DmProvider>');
  return context;
}
