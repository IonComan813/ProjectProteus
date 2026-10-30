// 世界卡加密。
//
// 锁定的内容（System Prompt、世界观、开场白、是否发送开场白、艺术图）用软件内置的密钥加密，
// 所以任何人的 Proteus 都能读取并使用这些内容；直接打开文件只能看到乱码。
// 创作者设置的密码不参与加密，只保存它的校验值（PBKDF2），用来解锁“查看和编辑”的权限。
//
// 注意：本项目是开源的，内置密钥写在这里；而且内容最终要以明文发给模型。
// 所以这只能防止直接查看文件和在软件界面里复制，挡不住有技术能力、刻意要拿到内容的人。
const Locker = (() => {
  const APP_KEY_B64 = '0hca01Cg7P6isXuSBmRfjV0hLBl7qkNVwOc3Sj625AY=';
  const ITERATIONS = 300000;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let keyPromise = null;

  function available() {
    return !!(window.crypto && crypto.subtle);
  }

  function toB64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function fromB64(b64) {
    const s = atob(b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes;
  }

  function appKey() {
    if (!keyPromise) keyPromise = crypto.subtle.importKey('raw', fromB64(APP_KEY_B64), 'AES-GCM', false, ['encrypt', 'decrypt']);
    return keyPromise;
  }

  async function encryptBytes(bytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await appKey(), bytes);
    return { iv: toB64(iv), data: toB64(data) };
  }

  async function decryptBytes(box) {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, await appKey(), fromB64(box.data)));
  }

  async function hashPassword(password, saltB64, iterations) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: fromB64(saltB64), iterations, hash: 'SHA-256' }, base, 256);
    return toB64(bits);
  }

  // 生成锁：fields 是 { systemPrompt, worldText, greeting, greetingSend }
  async function lock(fields, password) {
    const salt = toB64(crypto.getRandomValues(new Uint8Array(16)));
    const box = await encryptBytes(enc.encode(JSON.stringify(fields)));
    return { v: 1, salt, iterations: ITERATIONS, hash: await hashPassword(password, salt, ITERATIONS), iv: box.iv, data: box.data };
  }

  // 解出锁里的内容（不需要密码）
  async function open(lk) {
    return JSON.parse(dec.decode(await decryptBytes(lk)));
  }

  async function checkPassword(lk, password) {
    return (await hashPassword(password, lk.salt, lk.iterations)) === lk.hash;
  }

  // 艺术图：Blob ⇄ 加密盒 { iv, data, type }
  async function encryptBlob(blob) {
    const box = await encryptBytes(new Uint8Array(await blob.arrayBuffer()));
    return { ...box, type: blob.type || 'image/png' };
  }

  async function decryptBlob(box) {
    return new Blob([await decryptBytes(box)], { type: box.type || 'image/png' });
  }

  return { available, lock, open, checkPassword, encryptBlob, decryptBlob };
})();
