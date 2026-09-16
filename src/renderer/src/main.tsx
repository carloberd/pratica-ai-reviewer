import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/global.css'

const container = document.getElementById('root')
if (!container) throw new Error('Elemento #root non trovato')

// Su macOS la finestra non ha barra del titolo: il CSS lascia spazio ai semafori.
document.body.dataset.platform = window.reviewer.platform

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
