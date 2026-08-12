import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// wdth.css ships both the weight and width axes. The width axis is what the
// wordmark compression animates, so the default (weight-only) build is not
// enough here.
import '@fontsource-variable/anybody/wdth.css'
import '@fontsource/martian-mono/400.css'
import '@fontsource/martian-mono/700.css'
import './styles/tokens.css'
import './styles/global.css'
import { Shell } from './Shell'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
)
