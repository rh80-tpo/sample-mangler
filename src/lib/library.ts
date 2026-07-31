/**
 * Folders of saved mangles, stored in IndexedDB.
 *
 * IndexedDB rather than memory because losing a session's worth of keepers to
 * an accidental reload is unforgivable, and rather than localStorage because
 * these are multi-megabyte audio blobs, not strings.
 *
 * Still entirely on the machine. Nothing is uploaded.
 */

const DB_NAME = 'sample-mangler'
const DB_VERSION = 1
const FOLDERS = 'folders'
const ITEMS = 'items'

export type Folder = { id: string; name: string; createdAt: number }

export type Item = {
  id: string
  folderId: string
  name: string
  /** Encoded WAV, ready to hand straight to a download or a zip. */
  blob: Blob
  seconds: number
  sampleRate: number
  channels: number
  createdAt: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(FOLDERS)) {
        db.createObjectStore(FOLDERS, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(ITEMS)) {
        const store = db.createObjectStore(ITEMS, { keyPath: 'id' })
        store.createIndex('folderId', 'folderId', { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = run(t.objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

export function newId(): string {
  const a = new Uint32Array(2)
  crypto.getRandomValues(a)
  return `${a[0].toString(36)}${a[1].toString(36)}`
}

export async function listFolders(): Promise<Folder[]> {
  const all = await tx<Folder[]>(FOLDERS, 'readonly', (s) => s.getAll())
  return all.sort((a, b) => a.createdAt - b.createdAt)
}

export async function createFolder(name: string): Promise<Folder> {
  const folder: Folder = { id: newId(), name, createdAt: Date.now() }
  await tx(FOLDERS, 'readwrite', (s) => s.put(folder))
  return folder
}

export async function renameFolder(id: string, name: string): Promise<void> {
  const folder = await tx<Folder | undefined>(FOLDERS, 'readonly', (s) => s.get(id))
  if (!folder) return
  await tx(FOLDERS, 'readwrite', (s) => s.put({ ...folder, name }))
}

export async function deleteFolder(id: string): Promise<void> {
  const items = await listItems(id)
  await Promise.all(items.map((i) => deleteItem(i.id)))
  await tx(FOLDERS, 'readwrite', (s) => s.delete(id))
}

export async function listItems(folderId: string): Promise<Item[]> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const t = db.transaction(ITEMS, 'readonly')
    const idx = t.objectStore(ITEMS).index('folderId')
    const req = idx.getAll(folderId)
    req.onsuccess = () =>
      resolve((req.result as Item[]).sort((a, b) => a.createdAt - b.createdAt))
    req.onerror = () => reject(req.error)
  })
}

export async function countItems(): Promise<number> {
  return tx<number>(ITEMS, 'readonly', (s) => s.count())
}

export async function addItem(item: Omit<Item, 'id' | 'createdAt'>): Promise<Item> {
  const full: Item = { ...item, id: newId(), createdAt: Date.now() }
  await tx(ITEMS, 'readwrite', (s) => s.put(full))
  return full
}

export async function deleteItem(id: string): Promise<void> {
  await tx(ITEMS, 'readwrite', (s) => s.delete(id))
}

/** Rough bytes used, so the interface can be honest about what is stored. */
export async function totalBytes(): Promise<number> {
  const all = await tx<Item[]>(ITEMS, 'readonly', (s) => s.getAll())
  return all.reduce((sum, i) => sum + i.blob.size, 0)
}
