import { Dashboard, DashboardV2, Admin, Claims, PnL, Data, Supply } from './pages';

function App() {
  const path = window.location.pathname;
  if (path === '/admin') return <Admin />;
  if (path === '/claims') return <Claims />;
  if (path === '/pnl') return <PnL />;
  if (path === '/data') return <Data />;
  if (path === '/supply') return <Supply />;
  // The old Dune-backed dashboard, frozen at its last data. /v2 stays as an
  // alias because that's the link the preview was shared on.
  if (path === '/old') return <Dashboard archived />;
  return <DashboardV2 />;
}

export default App;
