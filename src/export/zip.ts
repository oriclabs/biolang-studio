export type ZipEntry = { name: string; data: string | Uint8Array };

const encoder = new TextEncoder();

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function write16(view: DataView, offset: number, value: number) { view.setUint16(offset, value, true); }
function write32(view: DataView, offset: number, value: number) { view.setUint32(offset, value, true); }

function dosDateTime(date: Date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

export function createZip(entries: ZipEntry[], date = new Date()) {
  const prepared = entries.map(entry => ({ name: encoder.encode(entry.name.replaceAll("\\", "/")), data: typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data }));
  const stamp = dosDateTime(date);
  const localSize = prepared.reduce((sum, entry) => sum + 30 + entry.name.length + entry.data.length, 0);
  const centralSize = prepared.reduce((sum, entry) => sum + 46 + entry.name.length, 0);
  const output = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(output.buffer);
  let offset = 0;
  const central: Array<{ entry: typeof prepared[number]; crc: number; localOffset: number }> = [];
  for (const entry of prepared) {
    const checksum = crc32(entry.data); const localOffset = offset;
    write32(view, offset, 0x04034b50); write16(view, offset + 4, 20); write16(view, offset + 6, 0x0800); write16(view, offset + 8, 0);
    write16(view, offset + 10, stamp.time); write16(view, offset + 12, stamp.date); write32(view, offset + 14, checksum);
    write32(view, offset + 18, entry.data.length); write32(view, offset + 22, entry.data.length); write16(view, offset + 26, entry.name.length); write16(view, offset + 28, 0);
    output.set(entry.name, offset + 30); output.set(entry.data, offset + 30 + entry.name.length);
    offset += 30 + entry.name.length + entry.data.length; central.push({ entry, crc: checksum, localOffset });
  }
  const centralOffset = offset;
  for (const item of central) {
    const { entry } = item;
    write32(view, offset, 0x02014b50); write16(view, offset + 4, 20); write16(view, offset + 6, 20); write16(view, offset + 8, 0x0800); write16(view, offset + 10, 0);
    write16(view, offset + 12, stamp.time); write16(view, offset + 14, stamp.date); write32(view, offset + 16, item.crc);
    write32(view, offset + 20, entry.data.length); write32(view, offset + 24, entry.data.length); write16(view, offset + 28, entry.name.length);
    write16(view, offset + 30, 0); write16(view, offset + 32, 0); write16(view, offset + 34, 0); write16(view, offset + 36, 0); write32(view, offset + 38, 0); write32(view, offset + 42, item.localOffset);
    output.set(entry.name, offset + 46); offset += 46 + entry.name.length;
  }
  write32(view, offset, 0x06054b50); write16(view, offset + 4, 0); write16(view, offset + 6, 0); write16(view, offset + 8, central.length); write16(view, offset + 10, central.length);
  write32(view, offset + 12, centralSize); write32(view, offset + 16, centralOffset); write16(view, offset + 20, 0);
  return output;
}
