/** Generates an ASCII text-layer PDF fixture; never calls a model or starts a service. */
import { readFile, writeFile } from 'node:fs/promises';
const source = new URL('../../data/samples/knowledge-core/contract-document.txt', import.meta.url);
const lines = (await readFile(source, 'utf8')).trim().split('\n');
const commands = 'BT /F1 10 Tf 40 780 Td ' + lines.map((line, i) => `${i ? '0 -24 Td ' : ''}(${line.replace(/[()\\]/g, '\\$&')}) Tj`).join('\n') + ' ET';
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 900 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`,
];
let pdf = '%PDF-1.4\n'; const offsets = [0];
for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
await writeFile(new URL('../../data/samples/knowledge-core/contract-document.pdf', import.meta.url), pdf, { flag: 'wx' });
