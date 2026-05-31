import { Dashboard, Admin, Claims, PnL, Data, Supply } from './pages';

function App() {
  const path = window.location.pathname;
  if (path === '/admin') return <Admin />;
  if (path === '/claims') return <Claims />;
  if (path === '/pnl') return <PnL />;
  if (path === '/data') return <Data />;
  if (path === '/supply') return <Supply />;
  return <Dashboard />;
}

export default App;
