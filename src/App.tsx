import { Dashboard, Admin, Claims, PnL } from './pages';

function App() {
  const path = window.location.pathname;
  if (path === '/admin') return <Admin />;
  if (path === '/claims') return <Claims />;
  if (path === '/pnl') return <PnL />;
  return <Dashboard />;
}

export default App;
