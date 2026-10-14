import ReactDOM from 'react-dom/client';
import Editor from './Editor';
import '../styles.css';
import './editor.css';

document.addEventListener('contextmenu', event => event.preventDefault());
document.addEventListener('keydown', event => {
  if (['F5', 'F12'].includes(event.key) || (event.ctrlKey && (['r', 'p'].includes(event.key.toLowerCase()) || event.shiftKey && ['i', 'j'].includes(event.key.toLowerCase())))) event.preventDefault();
});
ReactDOM.createRoot(document.getElementById('root')!).render(<Editor />);
