/**
 * Minimal dependency-free PDF writer (PDF 1.4, Helvetica, A4) for statements.
 * Text is limited to WinAnsi/Latin-1; Arabic glyph shaping is not supported here,
 * so PDFs use English names (the HTML/CSV statements carry Arabic).
 */
function esc(s: string) {
  return s.replace(/[^\x20-\x7E]/g, "?").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export type PdfLine = { text: string; size?: number; bold?: boolean; x?: number };

export function buildPdf(pages: PdfLine[][]): Buffer {
  const objs: string[] = [];
  const add = (s: string) => {
    objs.push(s);
    return objs.length;
  };
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  const boldId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>");
  const pagesId = add("PAGES_PLACEHOLDER");
  const pageIds: number[] = [];
  for (const lines of pages) {
    let y = 800;
    const ops: string[] = ["BT"];
    for (const l of lines) {
      const size = l.size ?? 9;
      ops.push(`/${l.bold ? "F2" : "F1"} ${size} Tf 1 0 0 1 ${l.x ?? 40} ${y} Tm (${esc(l.text)}) Tj`);
      y -= size + 5;
    }
    ops.push("ET");
    const stream = ops.join("\n");
    const contentId = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${boldId} 0 R >> >> /Contents ${contentId} 0 R >>`));
  }
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}
