'use strict';
// IndexedDB stores an authorized handle, never a guessed filesystem path.
const galaDirectoryMemory = {
  async access(mode, handle) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('gala-preferences', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('preferences');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Kho lưu thư mục đang bị khóa.'));
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction('preferences', mode);
        const store = transaction.objectStore('preferences');
        const request = mode === 'readonly' ? store.get('directory') : store.put(handle, 'directory');
        let value;
        request.onsuccess = () => {value = request.result;};
        transaction.oncomplete = () => resolve(value);
        transaction.onabort = () => reject(transaction.error || new Error('Không lưu được thư mục.'));
        transaction.onerror = () => {}; // onabort owns the failure.
      });
    } finally {db.close();}
  }
};
window.galaEnvironmentReady = new Promise(resolve => {
  const dialog = document.getElementById('environment-dialog');
  const status = document.getElementById('environment-status');
  const button = document.getElementById('choose-directory');
  const other = document.getElementById('change-directory');
  const title = document.getElementById('environment-title');
  let saved, busy = false;
  document.getElementById('spin').disabled = true;
  dialog.addEventListener('cancel', event => event.preventDefault());
  if (!window.isSecureContext || !window.showDirectoryPicker || !window.DecompressionStream) {
    status.textContent = 'Trình duyệt này không hỗ trợ đầy đủ quyền thư mục/Excel. Hãy mở index.html bằng Chrome hoặc Edge desktop mới, không dùng chế độ ẩn danh hay trình xem HTML trong ứng dụng khác.';
    button.disabled = true; dialog.showModal(); return;
  }
  function show() {
    title.textContent = saved ? 'Mở lại thư mục dữ liệu' : 'Chọn thư mục lưu dữ liệu';
    button.textContent = saved ? `Cho phép dùng lại thư mục ${saved.name}` : 'Chọn thư mục & bắt đầu';
    other.hidden = !saved;
    if (!dialog.open) dialog.showModal();
  }
  async function activate(handle) {
    let release;
    // Take the cooperating-tab lock BEFORE probing/writing to the directory.
    if (navigator.locks) {
      const held = new Promise(done => {release = done;});
      await new Promise((ready, fail) => {
        navigator.locks.request(`gala-directory-${handle.name}`, {ifAvailable: true}, async lock => {
          if (!lock) {fail(new Error('Một tab Gala khác đang dùng thư mục cùng tên. Đóng tab đó rồi thử lại.')); return;}
          ready(); await held;
        }).catch(fail);
      });
    }
    try {await GalaStorage.attach(handle);}
    catch (error) {release?.(); throw error;}
    if (release) window.addEventListener('pagehide', release, {once: true});
    let remembered = true;
    try {await galaDirectoryMemory.access('readwrite', handle);}
    catch {remembered = false;}
    const saveStatus = document.getElementById('save-status');
    if (saveStatus) saveStatus.textContent = `Lưu vào: ${handle.name} · ${remembered ? 'Đã nhớ thư mục' : 'Không nhớ được thư mục; lần sau cần chọn lại'}`;
    dialog.close(); resolve(true);
  }
  async function connect(useSaved) {
    if (busy) return;
    busy = true; button.disabled = true; other.disabled = true;
    try {
      // requestPermission must be called immediately from the user gesture.
      let handle;
      if (useSaved && saved) {
        handle = saved;
        if (await handle.requestPermission({mode: 'readwrite'}) !== 'granted') throw new Error('Chưa có quyền đọc/ghi. Cho phép dùng lại hoặc chọn thư mục khác.');
      } else {
        handle = await window.showDirectoryPicker({id: 'gala-data', mode: 'readwrite'});
        if (await handle.queryPermission({mode: 'readwrite'}) !== 'granted' && await handle.requestPermission({mode: 'readwrite'}) !== 'granted') throw new Error('Cần quyền đọc/ghi để lưu kết quả.');
      }
      saved = handle;
      await activate(handle);
    } catch (error) {
      show();
      status.textContent = error.name === 'AbortError' ? 'Bạn chưa chọn thư mục. Nhấn nút để chọn lại khi sẵn sàng.' : `Chưa thể mở dữ liệu: ${error.message}`;
    } finally {busy = false; button.disabled = false; other.disabled = false;}
  }
  button.onclick = () => connect(true);
  other.onclick = () => connect(false);
  // Automatic restore only queries permission; it never requests it silently.
  (async () => {
    busy = true; button.disabled = true;
    try {
      saved = await galaDirectoryMemory.access('readonly');
      if (saved?.kind !== 'directory') saved = undefined;
      if (saved && await saved.queryPermission({mode: 'readwrite'}) === 'granted') {
        await activate(saved); return;
      }
      status.textContent = saved ? `Đã nhớ thư mục ${saved.name}. Bấm cho phép dùng lại, không cần chọn lại thư mục.` : 'Chọn thư mục dữ liệu một lần; ứng dụng sẽ ghi nhớ để mở lại khi còn quyền.';
    } catch (error) {
      status.textContent = saved ? `Không mở lại được thư mục ${saved.name}: ${error.message}. Bạn có thể cấp lại quyền hoặc chọn thư mục khác.` : 'Trình duyệt chưa lưu/đọc được thư mục đã nhớ. Bạn vẫn có thể chọn thư mục để dùng.';
    } finally {busy = false; button.disabled = false;}
    show();
  })();
});
