// IndexedDB storage: projects (JSON, no images) and photos (JPEG blobs + annotations)
const DB_NAME = 'site-survey';
const DB_VERSION = 1;

let dbPromise;
function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('projects', { keyPath: 'id' });
        d.createObjectStore('photos', { keyPath: 'id' }).createIndex('projectId', 'projectId');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const db = {
  allProjects: () => tx('projects', 'readonly', s => s.getAll()),
  getProject: id => tx('projects', 'readonly', s => s.get(id)),
  putProject: p => tx('projects', 'readwrite', s => s.put(p)),
  photosOf: projectId => tx('photos', 'readonly', s => s.index('projectId').getAll(projectId)),
  putPhoto: p => tx('photos', 'readwrite', s => s.put(p)),
  deletePhoto: id => tx('photos', 'readwrite', s => s.delete(id)),
  async deleteProject(id) {
    const list = await db.photosOf(id);
    await tx('photos', 'readwrite', s => list.forEach(p => s.delete(p.id)));
    return tx('projects', 'readwrite', s => s.delete(id));
  },
};
