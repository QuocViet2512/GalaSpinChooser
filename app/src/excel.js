'use strict';
// Minimal data-table XLSX/CSV codec. All resources stay local; no formulas/macros run.
window.GalaExcel = (() => {
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const MAX_XML = 180_000_000;
  const crcTable = Uint32Array.from({length: 256}, (_, n) => {
    for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function xml(text) {
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('Excel chứa XML không được hỗ trợ.');
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('XML trong Excel không hợp lệ.');
    return doc;
  }
  const tags = (element, name) => Array.from(element.getElementsByTagNameNS('*', name));
  const text = (element, name) => tags(element, name).map(n => n.textContent).join('');
  const xmlEscape = value => String(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  async function unzip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = bytes.length - 22;
    while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end, true) !== 0x06054b50) end--;
    if (end < 0 || view.getUint32(end, true) !== 0x06054b50) throw new Error('File XLSX không phải ZIP hợp lệ.');
    const count = view.getUint16(end + 10, true);
    let offset = view.getUint32(end + 16, true), expanded = 0;
    const entries = new Map();
    for (let i = 0; i < count; i++) {
      if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIP directory bị lỗi.');
      const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true);
      const checksum = view.getUint32(offset + 16, true), compressed = view.getUint32(offset + 20, true);
      const size = view.getUint32(offset + 24, true), nameLength = view.getUint16(offset + 28, true);
      const extra = view.getUint16(offset + 30, true), comment = view.getUint16(offset + 32, true);
      const local = view.getUint32(offset + 42, true);
      const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      expanded += size;
      if (expanded > MAX_XML || count > 10000 || flags & 1) throw new Error('Excel quá lớn hoặc có mã hóa.');
      entries.set(name, {method, checksum, compressed, size, local});
      offset += 46 + nameLength + extra + comment;
    }
    return async name => {
      const entry = entries.get(name);
      if (!entry) return null;
      const {method, checksum, compressed, size, local} = entry;
      if (view.getUint32(local, true) !== 0x04034b50) throw new Error('ZIP header bị lỗi.');
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      if (start + compressed > bytes.length) throw new Error('ZIP bị cắt ngắn.');
      let output = bytes.subarray(start, start + compressed);
      if (method === 8) {
        const reader = new Blob([output]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
        const chunks = []; let total = 0;
        try {
          while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            total += value.length;
            if (total > size || total > MAX_XML) throw new Error('Excel giải nén vượt giới hạn.');
            chunks.push(value);
          }
        } catch (error) {await reader.cancel().catch(() => {}); throw error;}
        output = new Uint8Array(total); let position = 0;
        for (const chunk of chunks) {output.set(chunk, position); position += chunk.length;}
      } else if (method !== 0) throw new Error('Excel sử dụng kiểu nén không được hỗ trợ.');
      if (output.length !== size || crc32(output) !== checksum) throw new Error('Excel hỏng hoặc checksum không khớp.');
      return decoder.decode(output);
    };
  }

  function csvRows(value) {
    value = value.replace(/^\uFEFF/, '');
    const first = value.split(/\r?\n/, 1)[0];
    const delimiter = [',', ';', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
    const rows = []; let row = [], field = '', quoted = false;
    for (let i = 0; i < value.length; i++) {
      const c = value[i];
      if (c === '"') {
        if (quoted && value[i + 1] === '"') {field += '"'; i++;}
        else quoted = !quoted;
      } else if (!quoted && c === delimiter) {row.push(field); field = '';}
      else if (!quoted && (c === '\n' || c === '\r')) {
        if (c === '\r' && value[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (quoted) throw new Error('CSV thiếu dấu đóng ngoặc kép.');
    if (field || row.length) {row.push(field); rows.push(row);}
    return rows;
  }

  async function readRows(file) {
    if (file.size > 30_000_000) throw new Error('File tối đa 30 MB.');
    if (/\.csv$/i.test(file.name)) return csvRows(await file.text());
    if (!/\.xlsx$/i.test(file.name)) throw new Error('Chỉ hỗ trợ .xlsx hoặc .csv UTF-8.');
    const read = await unzip(new Uint8Array(await file.arrayBuffer()));
    const workbook = xml(await read('xl/workbook.xml') || '');
    const first = tags(workbook, 'sheet')[0];
    if (!first) throw new Error('Excel không có worksheet.');
    const id = first.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const rel = tags(xml(await read('xl/_rels/workbook.xml.rels') || ''), 'Relationship').find(r => r.getAttribute('Id') === id);
    if (!rel || rel.getAttribute('TargetMode') === 'External') throw new Error('Không tìm thấy sheet dữ liệu.');
    let target = rel.getAttribute('Target');
    target = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
    const parts = [];
    for (const part of target.split('/')) {if (part === '..') parts.pop(); else if (part !== '.') parts.push(part);}
    const sharedXML = await read('xl/sharedStrings.xml');
    const shared = sharedXML ? tags(xml(sharedXML), 'si').map(si => text(si, 't')) : [];
    const sheet = xml(await read(parts.join('/')) || '');
    const rows = [];
    for (const [index, element] of tags(sheet, 'row').entries()) {
      const row = [];
      for (const cell of tags(element, 'c')) {
        let col = 0;
        for (const letter of (cell.getAttribute('r') || 'A').replace(/[^A-Z]/g, '')) col = col * 26 + letter.charCodeAt(0) - 64;
        if (col < 1 || col > 512) continue;
        const type = cell.getAttribute('t'), value = text(cell, 'v');
        row[col - 1] = type === 's' ? shared[Number(value)] || '' : type === 'inlineStr' ? text(cell, 't') : value;
      }
      rows.push(row);
      if (index % 2000 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    return rows;
  }

  async function people(file) {
    const rows = await readRows(file), accepted = [], seen = new Set();
    let emailCol, nameCol = -1, employeeCol = -1, deptCol = -1, duplicates = 0, invalid = 0;
    for (const [index, raw] of rows.entries()) {
      const row = Array.from(raw, v => String(v ?? '').trim());
      if (!row.some(Boolean)) continue;
      if (emailCol === undefined) {
        const headers = row.map(v => v.toLowerCase().replace(/[\s_-]/g, ''));
        const header = headers.findIndex(v => ['email', 'mail', 'emailaddress', 'địachỉemail', 'emailcôngty'].includes(v));
        if (header >= 0) {
          emailCol = header;
          nameCol = headers.findIndex(v => ['name', 'fullname', 'họvàtên', 'họtên', 'tên', 'tênnhânviên'].includes(v));
          employeeCol = headers.findIndex(v => ['employeeid', 'employeecode', 'staffid', 'mãnhânviên', 'manhanvien', 'mãnv', 'manv'].includes(v));
          deptCol = headers.findIndex(v => ['department', 'phòngban', 'bộphận'].includes(v));
          continue;
        }
        const inferred = row.findIndex(v => v.includes('@'));
        if (inferred < 0) continue;
        emailCol = inferred;
      }
      const email = (row[emailCol] || '').toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {invalid++; continue;}
      if (seen.has(email)) {duplicates++; continue;}
      seen.add(email);
      accepted.push({id: accepted.length, email, employeeCode: (row[employeeCol] || '').slice(0, 200), name: (row[nameCol] || '').slice(0, 200), department: (row[deptCol] || '').slice(0, 200)});
      if (accepted.length > 500000) throw new Error('Tối đa 500.000 nhân sự mỗi đợt.');
      if (index % 2000 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (!accepted.length) throw new Error('Không tìm thấy email hợp lệ ở sheet đầu tiên.');
    return {people: accepted, report: {accepted: accepted.length, duplicates, invalid}};
  }

  function zip(files) {
    const local = [], central = []; let offset = 0, centralSize = 0;
    for (const [name, content] of Object.entries(files)) {
      const filename = encoder.encode(name), data = encoder.encode(content), crc = crc32(data);
      const header = new Uint8Array(30 + filename.length), h = new DataView(header.buffer);
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, filename.length, true); header.set(filename, 30);
      const record = new Uint8Array(46 + filename.length), c = new DataView(record.buffer);
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
      c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, filename.length, true); c.setUint32(42, offset, true); record.set(filename, 46);
      local.push(header, data); central.push(record); offset += header.length + data.length; centralSize += record.length;
    }
    const end = new Uint8Array(22), e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, central.length, true); e.setUint16(10, central.length, true);
    e.setUint32(12, centralSize, true); e.setUint32(16, offset, true);
    return new Blob([...local, ...central, end], {type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  }

  async function write(rows) {
    const sheet = ['<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'];
    let i = 0;
    for (const row of rows) {
      i++;
      sheet.push(`<row r="${i}">` + row.map((value, j) => {
        let col = '', n = j + 1;
        while (n) {n--; col = String.fromCharCode(65 + n % 26) + col; n = Math.floor(n / 26);}
        return `<c r="${col}${i}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
      }).join('') + '</row>');
      if (i % 2000 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    sheet.push('</sheetData></worksheet>');
    return zip({
      '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Gala" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': sheet.join('')
    });
  }
  const templateRows = [['Mã nhân viên', 'Tên nhân viên', 'Email công ty', 'Phòng ban'], ['NV0001', 'Nguyễn Văn A', 'nguyenvan.a@example.com', 'Kinh doanh']];
  return {people, readRows, write, csvRows, crc32, templateRows};
})();