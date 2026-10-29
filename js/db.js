// 本地存储：用浏览器自带的 IndexedDB 保存设定、对话和图片。
// 数据只存在这台电脑的这个浏览器里。
const DB = (() => {
  const DB_NAME = 'proteus';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('conversations')) db.createObjectStore('conversations', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      const req = fn(s);
      if (req) req.onsuccess = () => { result = req.result; };
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  return {
    get: (key) => tx('kv', 'readonly', (s) => s.get(key)),
    set: (key, value) => tx('kv', 'readwrite', (s) => s.put(value, key)),
    del: (key) => tx('kv', 'readwrite', (s) => s.delete(key)),
    getConversation: (id) => tx('conversations', 'readonly', (s) => s.get(id)),
    putConversation: (conv) => tx('conversations', 'readwrite', (s) => s.put(conv)),
    deleteConversation: (id) => tx('conversations', 'readwrite', (s) => s.delete(id)),
    listConversations: () => tx('conversations', 'readonly', (s) => s.getAll()),
    clearConversations: () => tx('conversations', 'readwrite', (s) => s.clear()),
  };
})();
