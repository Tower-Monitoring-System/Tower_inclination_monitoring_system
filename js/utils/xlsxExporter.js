const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const encoder = new TextEncoder();
let crcTable;

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnName(index) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function buildCrcTable() {
  return Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
  });
}

function crc32(bytes) {
  crcTable ||= buildCrcTable();
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatenate(chunks) {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  chunks.forEach((chunk) => {
    combined.set(chunk, offset);
    offset += chunk.length;
  });
  return combined;
}

function localHeader(nameBytes, dataBytes, checksum) {
  const header = new Uint8Array(30);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0x0800, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0x0021, true);
  view.setUint32(14, checksum, true);
  view.setUint32(18, dataBytes.length, true);
  view.setUint32(22, dataBytes.length, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, 0, true);
  return header;
}

function centralHeader(nameBytes, dataBytes, checksum, offset) {
  const header = new Uint8Array(46);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0x0800, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, 0x0021, true);
  view.setUint32(16, checksum, true);
  view.setUint32(20, dataBytes.length, true);
  view.setUint32(24, dataBytes.length, true);
  view.setUint16(28, nameBytes.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, offset, true);
  return header;
}

function createZip(files) {
  const localChunks = [];
  const centralChunks = [];
  let localOffset = 0;

  files.forEach(({ name, content }) => {
    const nameBytes = encoder.encode(name);
    const dataBytes = encoder.encode(content);
    const checksum = crc32(dataBytes);
    const local = localHeader(nameBytes, dataBytes, checksum);
    localChunks.push(local, nameBytes, dataBytes);
    centralChunks.push(centralHeader(nameBytes, dataBytes, checksum, localOffset), nameBytes);
    localOffset += local.length + nameBytes.length + dataBytes.length;
  });

  const centralDirectory = concatenate(centralChunks);
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, files.length, true);
  view.setUint16(10, files.length, true);
  view.setUint32(12, centralDirectory.length, true);
  view.setUint32(16, localOffset, true);
  view.setUint16(20, 0, true);

  return concatenate([...localChunks, centralDirectory, end]);
}

function inlineStringCell(reference, value, style = 0) {
  const styleAttribute = style ? ` s="${style}"` : "";
  return `<c r="${reference}" t="inlineStr"${styleAttribute}><is><t>${escapeXml(value)}</t></is></c>`;
}

function numberCell(reference, value) {
  return `<c r="${reference}" t="n"><v>${Number(value)}</v></c>`;
}

function buildWorksheet(readings) {
  const headers = ["Date", "Time", "X (°)", "Y (°)", "Z (°)", "Battery (V)"];
  const headerCells = headers
    .map((header, index) => inlineStringCell(`${columnName(index)}1`, header, 1))
    .join("");
  const dataRows = readings.map((reading, rowIndex) => {
    const rowNumber = rowIndex + 2;
    const cells = [
      inlineStringCell(`A${rowNumber}`, reading.date),
      inlineStringCell(`B${rowNumber}`, reading.time),
      numberCell(`C${rowNumber}`, reading.x),
      numberCell(`D${rowNumber}`, reading.y),
      numberCell(`E${rowNumber}`, reading.z),
      numberCell(`F${rowNumber}`, reading.battery)
    ].join("");
    return `<row r="${rowNumber}">${cells}</row>`;
  }).join("");
  const lastRow = Math.max(1, readings.length + 1);

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:F${lastRow}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols><col min="1" max="2" width="16" customWidth="1"/><col min="3" max="6" width="14" customWidth="1"/></cols>
  <sheetData><row r="1">${headerCells}</row>${dataRows}</sheetData>
  <autoFilter ref="A1:F${lastRow}"/>
</worksheet>`;
}

function workbookFiles(readings) {
  return [
    {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`
    },
    {
      name: "_rels/.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
    },
    {
      name: "xl/workbook.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sensor Data" sheetId="1" r:id="rId1"/></sheets>
</workbook>`
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
    },
    {
      name: "xl/styles.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F73ED"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center"/></xf></cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`
    },
    { name: "xl/worksheets/sheet1.xml", content: buildWorksheet(readings) }
  ];
}

export function createSensorDataWorkbook(readings) {
  if (!Array.isArray(readings) || readings.length === 0) {
    throw new TypeError("At least one sensor reading is required for export.");
  }
  return new Blob([createZip(workbookFiles(readings))], { type: XLSX_MIME });
}

export function downloadSensorDataWorkbook(readings, fileName, documentRef = document) {
  const blob = createSensorDataWorkbook(readings);
  const url = URL.createObjectURL(blob);
  const link = documentRef.createElement("a");
  link.href = url;
  link.download = fileName.endsWith(".xlsx") ? fileName : `${fileName}.xlsx`;
  documentRef.body?.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
