import { Dashboard, Admin, Claims, PnL, Data } from './pages';

function App() {
  const path = window.location.pathname;
  if (path === '/admin') return <Admin />;
  if (path === '/claims') return <Claims />;
  if (path === '/pnl') return <PnL />;
  if (path === '/data') return <Data />;
  return <Dashboard />;
}

export default App;
