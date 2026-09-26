import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// No <StrictMode>: it would mount the WebGL engine twice in development.
createRoot(document.getElementById('root')).render(<App />);
