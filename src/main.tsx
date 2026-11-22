import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installCanvasTextMeasurer } from './core/textMetrics';
import './styles/tokens.css';
import './styles/base.css';
import './styles/start.css';
import './styles/editor.css';
import './styles/panels.css';
import './styles/canvas.css';
import './styles/chemistry.css';

// 文本包围盒改用 Canvas 实测，必须在首屏渲染前安装。
installCanvasTextMeasurer();

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
