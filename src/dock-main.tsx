import React from 'react'
import ReactDOM from 'react-dom/client'
import Dock from './Dock'
import { NectarMotionProvider } from './components/NectarMotionProvider'
import './Dock.css'

document.addEventListener('contextmenu', (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <NectarMotionProvider>
      <Dock />
    </NectarMotionProvider>
  </React.StrictMode>,
)
