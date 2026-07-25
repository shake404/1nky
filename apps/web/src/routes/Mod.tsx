import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Identicon } from '../components/Identicon.js';
import { Spraying } from '../components/Spraying.js';
import { flagLabel } from '../lib/flag.js';
import {
  banWriter,
  dismissReport,
  fetchBanlist,
  fetchModQueue,
  forgetModKey,
  loadDismissed,
  loadModKey,
  ModError,
  reporterAge,
  saveModKey,
  takeDown,
  takeDownAndBan,
  unbanWriter,
  type BannedWriter,
  type ModReport,
} from '../lib/mod.js';
import { ago } from '../lib/platform.js';
import type { Stage } from '../lib/publish.js';
import { useTag } from '../state/TagProvider.js';
import { useToast } from '../state/ToastProvider.js';

type Panel = 'queue' | 'banned';

/**
 * The mod console.
 *
 * Not in the nav and not linked from anywhere a writer would stumble onto it:
 * you get here by typing /mod, and the screen is useless without the key. The
 * key is stored on the device, never put in the address bar.
 *
 * Reads come from the read API. Every action on this page is a signed post
 * from the mod's own tag — same wall, same work, same audit trail as anything
 * else that goes up.
 */
export function Mod(): JSX.Element {
  const { tag } = useTag();
  const { say } = useToast();

  const [key, setKey] = useState<string>('');
  const [keyLoaded, setKeyLoaded] = useState(false);
  const [draftKey, setDraftKey] = useState('');
  const [panel, setPanel] = useState<Panel>('queue');

  const [reports, setReports] = useState<ModReport[]>([]);
  const [banned, setBanned] = useState<BannedWriter[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [stage, setStage] = useState<Stage | null>(null);

  useEffect(() => {
    void (async () => {
      setKey(await loadModKey());
      setDismissed(await loadDismissed());
      setKeyLoaded(true);
    })();
  }, []);

  const load = useCallback(
    async (which: Panel, withKey: string) => {
      if (!withKey) return;
      setLoading(true);
      setProblem(null);
      try {
        if (which === 'queue') setReports(await fetchModQueue(withKey));
        else setBanned(await fetchBanlist(withKey));
        setLocked(false);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not load that.';
        setProblem(message);
        // A bad key sends us back to the gate; everything else is transient.
        setLocked(error instanceof ModError && error.failure === 'badkey');
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!keyLoaded || !key) return;
    void load(panel, key);
  }, [keyLoaded, key, panel, load]);

  const useKey = async (): Promise<void> => {
    const trimmed = draftKey.trim();
    if (!trimmed) return;
    await saveModKey(trimmed);
    setDraftKey('');
    setLocked(false);
    setProblem(null);
    setKey(trimmed);
  };

  const dropKey = async (): Promise<void> => {
    await forgetModKey();
    setKey('');
    setReports([]);
    setBanned([]);
    setProblem(null);
    setLocked(false);
  };

  /** Wrap an action so every one of them shows the wait and reports the same way. */
  const run = useCallback(
    async (work: () => Promise<void>, done: string): Promise<void> => {
      setStage('spraying');
      try {
        await work();
        say(done);
      } catch (error) {
        say(error instanceof Error ? error.message : 'That did not go up.', 'hazard');
      } finally {
        setStage(null);
      }
    },
    [say],
  );

  if (!keyLoaded) {
    return (
      <div className="shell empty">
        <p className="kicker">loading</p>
      </div>
    );
  }

  // --- The gate --------------------------------------------------------------
  if (!key || locked) {
    return (
      <div className="shell pad stack stack--wide">
        <h2>Mod console</h2>
        <p className="muted">Staff only. Paste the mod key to get in.</p>
        {locked && problem ? <p className="error">{problem}</p> : null}
        <div className="field">
          <label htmlFor="mod-key">Mod key</label>
          <input
            id="mod-key"
            className="input"
            type="password"
            autoComplete="off"
            value={draftKey}
            onChange={(event) => setDraftKey(event.target.value)}
          />
          <button
            type="button"
            className="btn btn--go btn--sm sticker"
            onClick={() => void useKey()}
            disabled={!draftKey.trim()}
          >
            Let me in
          </button>
        </div>
        <p className="help">Stays on this device. Never in the address bar.</p>
      </div>
    );
  }

  const open = reports.filter((report) => !dismissed.includes(report.id));

  return (
    <div className="shell pad stack stack--wide">
      {stage ? <Spraying stage={stage} /> : null}

      <h2>Mod console</h2>

      <div className="chips" role="tablist" aria-label="Mod console">
        <button
          type="button"
          role="tab"
          aria-selected={panel === 'queue'}
          className={`chip${panel === 'queue' ? ' chip--active' : ''}`}
          onClick={() => setPanel('queue')}
        >
          Queue
          {open.length > 0 ? <span className="chip__count">{open.length}</span> : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={panel === 'banned'}
          className={`chip${panel === 'banned' ? ' chip--active' : ''}`}
          onClick={() => setPanel('banned')}
        >
          Banned
        </button>
      </div>

      <div className="row spread">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => void load(panel, key)}
          disabled={loading}
        >
          {loading ? 'Looking...' : 'Refresh'}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void dropKey()}>
          Forget this key
        </button>
      </div>

      {problem ? <p className="error">{problem}</p> : null}

      {panel === 'queue' ? (
        open.length === 0 && !loading ? (
          <div className="empty">
            <h2>Queue is clear.</h2>
            <p className="muted">Nothing waiting.</p>
          </div>
        ) : (
          <ul className="list-reset stack">
            {open.map((report) => (
              <li key={report.id}>
                <ReportCard
                  report={report}
                  onAct={run}
                  onDismiss={async () => setDismissed(await dismissReport(report.id))}
                  reload={() => void load('queue', key)}
                  tag={tag}
                />
              </li>
            ))}
          </ul>
        )
      ) : banned.length === 0 && !loading ? (
        <div className="empty">
          <h2>Nobody banned.</h2>
          <p className="muted">Clean slate.</p>
        </div>
      ) : (
        <ul className="list-reset stack">
          {banned.map((writer) => (
            <li key={writer.pubkey} className="mod-row">
              <div className="row" style={{ gap: 10, minWidth: 0 }}>
                <Identicon pubkey={writer.pubkey} size={28} />
                <div style={{ minWidth: 0 }}>
                  <p className="mono">{writer.mark}</p>
                  <p className="kicker">
                    banned {ago(writer.bannedAt)} ago · {writer.eventCount} up · {writer.reportCount} flags
                  </p>
                  {writer.reason ? <p className="muted">{flagLabel(writer.reason)}</p> : null}
                </div>
              </div>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={!tag}
                onClick={() =>
                  void run(async () => {
                    if (!tag) return;
                    await unbanWriter(tag, writer.pubkey);
                    void load('banned', key);
                  }, 'Back on the wall.')
                }
              >
                Unban
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface CardProps {
  report: ModReport;
  tag: ReturnType<typeof useTag>['tag'];
  onAct: (work: () => Promise<void>, done: string) => Promise<void>;
  onDismiss: () => Promise<void>;
  reload: () => void;
}

/** One flagged post, with everything needed to make the call in one screen. */
function ReportCard({ report, tag, onAct, onDismiss, reload }: CardProps): JSX.Element {
  const { target, reporter } = report;
  const canBan = Boolean(tag && target.pubkey);
  const canTakeDown = Boolean(tag && target.eventId && target.present);

  return (
    <article className={`mod-card${target.banned ? ' mod-card--banned' : ''}`}>
      <div className="mod-card__head">
        {target.thumbnailUrl ? (
          <img className="mod-card__thumb" src={target.thumbnailUrl} alt="" loading="lazy" decoding="async" />
        ) : (
          <div className="mod-card__thumb mod-card__thumb--none" aria-hidden="true" />
        )}

        <div className="stack" style={{ gap: 6, minWidth: 0 }}>
          <div className="chips" style={{ gap: 6 }}>
            <span className="chip chip--reason">{flagLabel(report.reason)}</span>
            {target.banned ? <span className="chip chip--reason">already banned</span> : null}
            {target.present ? null : <span className="chip chip--reason">already gone</span>}
          </div>

          <p className="mod-card__who">
            <span className="writer__name">{target.tag?.trim() || 'unnamed'}</span>{' '}
            <span className="mono faint">{target.mark ?? '------'}</span>
          </p>

          <p className="kicker">
            {target.reportCount} flag{target.reportCount === 1 ? '' : 's'} on them ·{' '}
            flagged {ago(report.createdAt)} ago
          </p>
        </div>
      </div>

      {target.content ? <p className="mod-card__body">{target.content}</p> : null}

      {report.note ? (
        <p className="muted">
          <span className="kicker">said</span> {report.note}
        </p>
      ) : null}

      <p className="kicker">
        flagged by {reporter.mark || '------'} · {reporterAge(reporter.firstEventAt)} ·{' '}
        {reporter.eventCount} up · {reporter.reportCount} flags on them
      </p>

      {target.eventId && target.present ? (
        <Link to={`/f/${target.eventId}`} className="mono mod-card__link">
          Look at it
        </Link>
      ) : null}

      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn btn--danger btn--sm"
          disabled={!canBan}
          onClick={() =>
            void onAct(async () => {
              if (!tag) return;
              await takeDownAndBan(tag, report);
              await onDismiss();
              reload();
            }, 'Buffed and banned.')
          }
        >
          Buff + ban
        </button>

        <button
          type="button"
          className="btn btn--danger btn--sm"
          disabled={!canTakeDown}
          onClick={() =>
            void onAct(async () => {
              if (!tag || !target.eventId) return;
              await takeDown(tag, target.eventId, target.kind);
              await onDismiss();
              reload();
            }, 'Buffed.')
          }
        >
          Buff this
        </button>

        <button
          type="button"
          className="btn btn--danger btn--sm"
          disabled={!canBan}
          onClick={() =>
            void onAct(async () => {
              if (!tag || !target.pubkey) return;
              await banWriter(tag, target.pubkey, report.reason);
              await onDismiss();
              reload();
            }, 'Banned.')
          }
        >
          Ban the writer
        </button>

        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void onDismiss()}>
          Leave it
        </button>
      </div>
    </article>
  );
}

