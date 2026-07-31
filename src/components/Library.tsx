import { useCallback, useEffect, useState } from 'react'
import {
  createFolder,
  deleteFolder,
  deleteItem,
  listFolders,
  listItems,
  renameFolder,
  type Folder,
  type Item,
} from '../lib/library'
import { buildZip, type ZipEntry } from '../lib/zip'

type Props = {
  open: boolean
  onToggle: () => void
  /** Bumped by the parent after a save, to pull fresh contents. */
  revision: number
  onNotice: (message: string) => void
  onLoad: (item: Item) => void
  /** Which folder SAVE currently drops into. */
  activeId: string | null
  onPickActive: (id: string, name: string) => void
  /** Save the current output straight into a specific folder. */
  onSaveTo: (id: string) => void
  /** True when there is something to save. */
  canSave: boolean
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 8000)
}

function safeName(s: string): string {
  return s.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'folder'
}

function fmtBytes(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`
}

export function Library({
  open,
  onToggle,
  revision,
  onNotice,
  onLoad,
  activeId,
  onPickActive,
  onSaveTo,
  canSave,
}: Props) {
  const [folders, setFolders] = useState<Folder[]>([])
  const [items, setItems] = useState<Record<string, Item[]>>({})
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const fs = await listFolders()
    setFolders(fs)
    const map: Record<string, Item[]> = {}
    for (const f of fs) map[f.id] = await listItems(f.id)
    setItems(map)
    // Something always has to be the destination, or SAVE has nowhere to go.
    if (fs.length && !fs.some((f) => f.id === activeId)) {
      onPickActive(fs[0].id, fs[0].name)
    }
  }, [activeId, onPickActive])

  useEffect(() => {
    void refresh()
  }, [refresh, revision])

  const total = folders.reduce((n, f) => n + (items[f.id]?.length ?? 0), 0)
  const bytes = folders.reduce(
    (n, f) => n + (items[f.id] ?? []).reduce((m, i) => m + i.blob.size, 0),
    0,
  )

  const exportFolder = useCallback(
    async (folder: Folder) => {
      const list = items[folder.id] ?? []
      if (!list.length) return
      setBusy(true)
      try {
        const entries = await Promise.all(
          list.map(async (item, i) => ({
            // Numbered so the zip opens in the order they were saved.
            name: `${String(i + 1).padStart(2, '0')}-${safeName(item.name)}.wav`,
            data: new Uint8Array(await item.blob.arrayBuffer()),
          })),
        )
        download(buildZip(entries), `${safeName(folder.name)}.zip`)
        onNotice(`exported ${list.length} from ${folder.name}.`)
      } finally {
        setBusy(false)
      }
    },
    [items, onNotice],
  )

  const exportEverything = useCallback(async () => {
    setBusy(true)
    try {
      const entries: ZipEntry[] = []
      for (const f of folders) {
        const list = items[f.id] ?? []
        for (let i = 0; i < list.length; i++) {
          entries.push({
            // Folder structure is carried by the path inside the zip.
            name: `${safeName(f.name)}/${String(i + 1).padStart(2, '0')}-${safeName(list[i].name)}.wav`,
            data: new Uint8Array(await list[i].blob.arrayBuffer()),
          })
        }
      }
      if (!entries.length) return
      download(buildZip(entries), 'sample-mangler-library.zip')
      onNotice(`exported ${entries.length} across ${folders.length} folders.`)
    } finally {
      setBusy(false)
    }
  }, [folders, items, onNotice])

  return (
    <section className={`lib${open ? ' lib--open' : ''}`}>
      <div className="lib__bar">
        <button
          type="button"
          className="lib__toggle"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls="library-body"
        >
          <span className="lib__chev" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          folders
          <span className="lib__count">
            {total} saved{bytes ? ` · ${fmtBytes(bytes)}` : ''}
          </span>
        </button>

        <div className="lib__acts">
          <button
            type="button"
            className="lib__act"
            disabled={busy}
            onClick={() => {
              void (async () => {
                const f = await createFolder(`folder ${folders.length + 1}`)
                // A folder you just made is the one you want to fill.
                onPickActive(f.id, f.name)
                await refresh()
                onNotice(`made ${f.name}. saves go here now.`)
              })()
            }}
          >
            new folder
          </button>
          <button
            type="button"
            className="lib__act lib__act--strong"
            disabled={busy || total === 0}
            onClick={() => void exportEverything()}
          >
            export all
          </button>
        </div>
      </div>

      <div className="lib__body" id="library-body" hidden={!open}>
        {folders.length === 0 ? (
          <p className="lib__empty">
            no folders yet. make one, then save mangles into it.
          </p>
        ) : (
          folders.map((f) => {
            const list = items[f.id] ?? []
            return (
              <div
                className={`fold${activeId === f.id ? ' fold--active' : ''}`}
                key={f.id}
              >
                <div className="fold__head">
                  {/* Marks where SAVE will drop things. A radio rather than a
                      button, because exactly one folder is the destination. */}
                  <button
                    type="button"
                    className="fold__target"
                    role="radio"
                    aria-checked={activeId === f.id}
                    onClick={() => onPickActive(f.id, f.name)}
                  >
                    <span className="sr-only">
                      {activeId === f.id
                        ? `${f.name} is where save goes`
                        : `Send saves to ${f.name}`}
                    </span>
                  </button>
                  <input
                    className="fold__name"
                    value={f.name}
                    aria-label={`Name of folder ${f.name}`}
                    onChange={(e) => {
                      const name = e.target.value
                      setFolders((prev) =>
                        prev.map((x) => (x.id === f.id ? { ...x, name } : x)),
                      )
                      if (activeId === f.id) onPickActive(f.id, name)
                    }}
                    onBlur={(e) => void renameFolder(f.id, e.target.value)}
                  />
                  <span className="fold__count">{list.length}</span>
                  <button
                    type="button"
                    className="lib__act lib__act--strong"
                    disabled={busy || !canSave}
                    onClick={() => onSaveTo(f.id)}
                  >
                    save here
                  </button>
                  <button
                    type="button"
                    className="lib__act"
                    disabled={busy || !list.length}
                    onClick={() => void exportFolder(f)}
                  >
                    export
                  </button>
                  <button
                    type="button"
                    className="lib__act lib__act--danger"
                    disabled={busy}
                    onClick={() => {
                      void (async () => {
                        await deleteFolder(f.id)
                        await refresh()
                        onNotice(`deleted ${f.name} and ${list.length} in it.`)
                      })()
                    }}
                  >
                    delete
                  </button>
                </div>

                {list.length ? (
                  <ul className="fold__items">
                    {list.map((item) => (
                      <li className="clip" key={item.id}>
                        <button
                          type="button"
                          className="clip__load"
                          onClick={() => onLoad(item)}
                        >
                          {item.name}
                        </button>
                        <span className="clip__meta">
                          {item.seconds.toFixed(2)}s · {fmtBytes(item.blob.size)}
                        </span>
                        <button
                          type="button"
                          className="clip__act"
                          onClick={() => download(item.blob, `${safeName(item.name)}.wav`)}
                        >
                          wav
                        </button>
                        <button
                          type="button"
                          className="clip__act clip__act--danger"
                          onClick={() => {
                            void (async () => {
                              await deleteItem(item.id)
                              await refresh()
                            })()
                          }}
                          aria-label={`Delete ${item.name}`}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="fold__empty">empty</p>
                )}
              </div>
            )
          })
        )}
      </div>
    </section>
  )
}
