export type SupportedUploadKind =
  | 'image'
  | 'pdf'
  | 'csv'
  | 'xlsx'
  | 'docx'
  | 'pptx'
  | 'text';

export type SniffedUpload = {
  kind: SupportedUploadKind;
  mimeType: string;
};

const extensionTypes: Record<string, SniffedUpload> = {
  csv: { kind: 'csv', mimeType: 'text/csv' },
  tsv: { kind: 'csv', mimeType: 'text/tab-separated-values' },
  xlsx: { kind: 'xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  xls: { kind: 'xlsx', mimeType: 'application/vnd.ms-excel' },
  docx: { kind: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  pptx: { kind: 'pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  txt: { kind: 'text', mimeType: 'text/plain' },
  md: { kind: 'text', mimeType: 'text/markdown' },
};

function textAt(bytes: Uint8Array, start: number, length: number) {
  return new TextDecoder().decode(bytes.slice(start, start + length));
}

function hasPrefix(bytes: Uint8Array, ...prefix: number[]) {
  return prefix.every((value, index) => bytes[index] === value);
}

/** Magic-byte first routing. ZIP-based office formats use their extension as a safe fallback. */
export function sniffUpload(fileName: string, bytes: Uint8Array): SniffedUpload | null {
  if (hasPrefix(bytes, 0x4d, 0x5a)) return null; // Windows PE / .exe
  if (hasPrefix(bytes, 0x89, 0x50, 0x4e, 0x47)) return { kind: 'image', mimeType: 'image/png' };
  if (hasPrefix(bytes, 0xff, 0xd8, 0xff)) return { kind: 'image', mimeType: 'image/jpeg' };
  if (textAt(bytes, 0, 6) === 'GIF87a' || textAt(bytes, 0, 6) === 'GIF89a') {
    return { kind: 'image', mimeType: 'image/gif' };
  }
  if (textAt(bytes, 0, 4) === 'RIFF' && textAt(bytes, 8, 4) === 'WEBP') {
    return { kind: 'image', mimeType: 'image/webp' };
  }
  if (textAt(bytes, 0, 4) === '%PDF') return { kind: 'pdf', mimeType: 'application/pdf' };

  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  return extensionTypes[extension] ?? null;
}

export function acceptedTypeLabel(kind: SupportedUploadKind) {
  return {
    image: 'Image',
    pdf: 'PDF',
    csv: 'CSV',
    xlsx: 'Spreadsheet',
    docx: 'Word document',
    pptx: 'PowerPoint',
    text: 'Text',
  }[kind];
}

/** Pre-enriched campaigns only accept tabular sheets (CSV/TSV/XLSX). */
export function isSheetUploadKind(kind: SupportedUploadKind): boolean {
  return kind === 'csv' || kind === 'xlsx';
}
