import * as iconv from 'iconv-lite';

export interface DecodedText {
  text: string;
  encoding: string;
}

// BOM이 있으면 그 인코딩을, 없으면 UTF-8로 엄격하게 읽어 보고
// 실패하면 한글 레거시 인코딩(CP949, EUC-KR 상위 호환)으로 읽는다.
export function detectAndDecode(buf: Buffer): DecodedText {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'UTF-8 with BOM' };
  }
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: iconv.decode(buf.subarray(2), 'utf16le'), encoding: 'UTF-16 LE' };
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: iconv.decode(buf.subarray(2), 'utf16be'), encoding: 'UTF-16 BE' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'UTF-8' };
  } catch {
    // UTF-8이 아니다.
  }
  const korean = iconv.decode(buf, 'cp949');
  // CP949로도 해석되지 않는 바이트가 있으면 기존처럼 UTF-8로 읽는다.
  return korean.includes('�')
    ? { text: buf.toString('utf8'), encoding: 'UTF-8 (invalid bytes)' }
    : { text: korean, encoding: 'CP949 (EUC-KR)' };
}

// VS Code 인코딩 ID(TextDocument.encoding)를 상태 표시줄에 보여줄 이름으로 바꾼다.
const EDITOR_ENCODING_LABELS: Record<string, string> = {
  utf8: 'UTF-8', utf8bom: 'UTF-8 with BOM', utf16le: 'UTF-16 LE', utf16be: 'UTF-16 BE',
  windows949: 'CP949 (EUC-KR)', euckr: 'EUC-KR',
};

export function editorEncodingLabel(id: string): string {
  return EDITOR_ENCODING_LABELS[id] ?? id.toUpperCase();
}

export function decodeText(buf: Buffer): string {
  return detectAndDecode(buf).text;
}

export function hasUtf16Bom(buf: Buffer): boolean {
  return (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff);
}
