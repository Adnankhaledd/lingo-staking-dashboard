import { Dashboard, Admin } from './pages';

function App() {
  const isAdmin = window.location.pathname === '/admin';
  return isAdmin ? <Admin /> : <Dashboard />;
}

export default App;
