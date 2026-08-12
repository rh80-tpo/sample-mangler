import { useEffect, useState } from 'react'
import { App } from './App'
import { Chopper } from './Chopper'
import { Wordmark } from './components/Wordmark'

type View = 'mangler' | 'chopper'

/**
 * Two tools, one shell.
 *
 * The view lives in the hash rather than a router: it survives a reload and
 * gives each tool a linkable address without pulling in routing for two
 * screens.
 */
function viewFromHash(): View {
  return window.location.hash.replace('#', '') === 'chopper' ? 'chopper' : 'mangler'
}

export function Shell() {
  const [view, setView] = useState<View>(viewFromHash)

  useEffect(() => {
    const onHash = () => setView(viewFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const go = (next: View) => {
    window.location.hash = next === 'chopper' ? 'chopper' : ''
    setView(next)
  }

  return (
    <div className="shell">
      <header className="shell__bar">
        <h1 className="mark">
          <span className="sr-only">HAZEN sample mangler</span>
          <Wordmark />
          <span aria-hidden="true">sample mangler</span>
        </h1>
        <nav className="shell__nav" aria-label="Tools">
          <button
            type="button"
            className="shell__tab"
            aria-current={view === 'mangler' ? 'page' : undefined}
            onClick={() => go('mangler')}
          >
            mangler
          </button>
          <button
            type="button"
            className="shell__tab"
            aria-current={view === 'chopper' ? 'page' : undefined}
            onClick={() => go('chopper')}
          >
            vocal chopper
          </button>
        </nav>
      </header>

      {view === 'mangler' ? <App embedded /> : <Chopper />}
    </div>
  )
}
