import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Shell } from './components/Shell.js';
import { Backup } from './routes/Backup.js';
import { Conversation } from './routes/Conversation.js';
import { CreateCrew } from './routes/CreateCrew.js';
import { Crew } from './routes/Crew.js';
import { Explore } from './routes/Explore.js';
import { Feed } from './routes/Feed.js';
import { FlickDetail } from './routes/FlickDetail.js';
import { HangItUp } from './routes/HangItUp.js';
import { Landing } from './routes/Landing.js';
import { Messages } from './routes/Messages.js';
import { PickTag } from './routes/PickTag.js';
import { PostFlick } from './routes/PostFlick.js';
import { ProfileEdit } from './routes/ProfileEdit.js';
import { Restore } from './routes/Restore.js';
import { Settings } from './routes/Settings.js';
import { MyWall, Writer } from './routes/Writer.js';
import { useTag } from './state/TagProvider.js';

function Booting(): JSX.Element {
  return (
    <div className="app app--bare">
      <div className="hero">
        <h1 className="hero__mark chrome">1NKY</h1>
      </div>
    </div>
  );
}

function NotFound(): JSX.Element {
  return (
    <div className="shell empty">
      <h2>Nothing here.</h2>
      <p className="muted">Wrong wall.</p>
    </div>
  );
}

export function App(): JSX.Element {
  const { tag, ready } = useTag();
  const location = useLocation();

  if (!ready) return <Booting />;

  // No tag: the only doors are the two onboarding ones.
  if (!tag) {
    return (
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/pick" element={<PickTag />} />
        <Route path="/restore" element={<Restore />} />
        <Route path="*" element={<Navigate to="/" replace state={{ from: location.pathname }} />} />
      </Routes>
    );
  }

  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Feed />} />
        <Route path="/explore" element={<Explore />} />
        <Route path="/f/:id" element={<FlickDetail />} />
        <Route path="/w/:pubkey" element={<Writer />} />
        <Route path="/crew/:pubkey" element={<Crew />} />
        <Route path="/crew/new" element={<CreateCrew />} />
        <Route path="/me" element={<MyWall />} />
        <Route path="/post" element={<PostFlick />} />
        <Route path="/messages" element={<Messages />} />
        <Route path="/messages/:pubkey" element={<Conversation />} />
        <Route path="/profile/edit" element={<ProfileEdit />} />
        <Route path="/backup" element={<Backup />} />
        <Route path="/restore" element={<Restore />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/hang-it-up" element={<HangItUp />} />
        <Route path="/pick" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Shell>
  );
}
