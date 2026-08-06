import { deflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPdfText } from '@/lib/pdf-text';

function pdfWithCompressedText(text: string) {
  const stream = deflateSync(Buffer.from(`BT (${text}) Tj ET`, 'latin1'));
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length '),
    Buffer.from(String(stream.byteLength)),
    Buffer.from(' /Filter /FlateDecode >>\nstream\n'),
    stream,
    Buffer.from('\nendstream\nendobj\n%%EOF'),
  ]);
}

test('PDF extraction reads compressed text operators', () => {
  const result = extractPdfText(pdfWithCompressedText('Jane Doe jane.doe@acme.com'));
  assert.match(result.text, /Jane Doe jane\.doe@acme\.com/);
  assert.equal(result.error, null);
});

test('PDF extraction does not treat arbitrary bytes as text', () => {
  const result = extractPdfText(Buffer.from('%PDF-1.4\nrandom jane.doe@acme.com\n%%EOF'));
  assert.equal(result.text, '');
  assert.equal(result.error, 'no_extractable_text');
});

test('PDF extraction rejects non-PDF data', () => {
  assert.equal(extractPdfText(Buffer.from('hello')).error, 'not_pdf');
});
