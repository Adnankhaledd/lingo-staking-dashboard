import { Dashboard, Admin, Claims } from './pages';

function App() {
  const path = window.location.pathname;
  if (path === '/admin') return <Admin />;
  if (path === '/claims') return <Claims />;
  return <Dashboard />;
}

export default App;
