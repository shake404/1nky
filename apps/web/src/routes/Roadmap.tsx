import { Link } from 'react-router-dom';

/**
 * `/roadmap` — what is up, what is being worked on, what is coming.
 *
 * Static on purpose: this is the same list the public docs carry, written in the
 * interface's voice, and it must render with nothing reachable. Nothing here is
 * fetched, so the page works on a dead connection and cannot go blank because a
 * read failed.
 *
 * Keep it honest. If a line here claims something is up and it is not, that is a
 * bug — and the fix is a line in /holler, which is where the page ends.
 */

interface Lane {
  /** Stencil label over the group. */
  kicker: string;
  title: string;
  note: string;
  items: readonly string[];
}

const LANES: readonly Lane[] = [
  {
    kicker: 'up already',
    title: 'Done',
    note: 'On the wall right now. If one of these is broken, that is worth a holler.',
    items: [
      'Pick a tag and start putting things up in about a minute. No name, no number, nothing to remember but your blackbook.',
      'Flicks, with the location and camera details destroyed on your own phone before the picture ever leaves it.',
      'The wall, a browser for spots and cities, and a wall of your own.',
      'Your blackbook: save it, lock it with a passphrase, bring it back on a new phone, or scan a block to move across.',
      'Boards for cities. Threads on them. Beef on a clock — a day, three days, a week, or pinned so it stays.',
      'Buff your own stuff whenever you want. Flag anybody else’s. Ignore a writer and never see them again.',
      'Marks and age dots wherever a tag shows up, so a bitten name is obvious at a glance.',
      'Search across what went up and who put it up.',
      'Crews: a shared tag, a crew page, a roster, and a handoff to the people in it.',
      'Word — messages nobody else can read. Not us either.',
      'Short clips, hard capped.',
      'Hang it up: retire a name properly, and take the work down with it.',
    ],
  },
  {
    kicker: 'getting sprayed',
    title: 'Being worked on',
    note: 'Half-painted. Weeks, not months.',
    items: [
      'Getting put on — an established writer vouches for the next one, and the newcomer’s wait goes away.',
      'A board for jams and meets, with the date on the post so it takes itself down a week after.',
      'Nightly copies of the whole wall, so a dead box never takes it with it.',
    ],
  },
  {
    kicker: 'next up',
    title: 'Coming',
    note: 'Agreed on and queued. Order can move.',
    items: [
      'Optional face and hand blur before a flick leaves your phone. All of it happens on the device — nothing goes anywhere to be looked at, and the blur is permanent.',
      'Recovery you can opt into: lock a spare blackbook with a passphrase and leave it here. We hold a locked file we cannot open. Off unless you turn it on.',
      'A mirror on the onion network — straight to the box, nothing in the middle that can see who came by.',
      'Spare copies of every picture, held somewhere that is not us.',
      'A proper beating under load, to find out where the box gives before a busy night does.',
    ],
  },
  {
    kicker: 'maybe, maybe not',
    title: 'Parked',
    note: 'Good ideas nobody has promised. Some are here because they are hard.',
    items: [
      'A crew it takes several members to speak for, instead of one shared blackbook where one leak burns everybody.',
      'A map of spots with the locations deliberately coarse — neighbourhood, never exact, always opt-in per post. Genuinely useful and genuinely dangerous, so it does not ship without a hard look at what it gives away.',
      'Boards built for slaps and blackbook pages rather than walls — different shapes, different layout.',
      'Write it with no bars and let it go up when you have some. Posting late is better practice anyway.',
      'Hold your tag in your own app instead of in this one, for the people who already do that.',
      'Other cities running their own box and joining up, so this place lasting stops depending on us.',
    ],
  },
];

export function Roadmap(): JSX.Element {
  return (
    <div className="shell pad stack stack--wide">
      <div>
        <span className="tape">roadmap</span>
        <h2 style={{ marginTop: 12 }}>What&apos;s coming</h2>
      </div>

      <p style={{ fontSize: '1.05rem' }}>
        No dates, because a date is a promise and this is a list. It is the order things
        get built in, and the order moves when people ask loud enough.
      </p>

      {LANES.map((lane) => (
        <section key={lane.kicker} className="stack">
          <hr className="rule" />
          <p className="kicker">{lane.kicker}</p>
          <h3>{lane.title}</h3>
          <p className="help">{lane.note}</p>
          <ul className="list-reset stack road">
            {lane.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      ))}

      <hr className="rule" />

      <div className="panel stack">
        <p className="display" style={{ fontSize: '1.4rem' }}>
          Want something? Holler.
        </p>
        <p className="muted">
          Nothing on this page got here from a meeting. It got here because somebody said
          it out loud.
        </p>
        <Link to="/holler" className="btn btn--go sticker">
          Holler at us
        </Link>
      </div>
    </div>
  );
}
