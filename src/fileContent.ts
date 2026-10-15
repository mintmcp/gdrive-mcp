/**
 * get_file's body: fetch a Drive file and turn it into a tool result, as text
 * (plain, PDF text layer, Office), an image block, or a reason it cannot be read.
 */

import { DriveApiError, formatDriveError, makeDriveRequest, GOOGLE_DRIVE_API } from './driveApi.js';
import { extractPdfText, MAX_TEXT_CHARS, type PdfText } from './pdfText.js';
import { extractOfficeText, isOfficeMime } from './officeText.js';
import { log, errorFields } from './log.js';

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

// MIME categorisation for get_file. We derive these from the *actual* metadata
// mimeType, not from caller-supplied input, so the tool can't be lied into
// returning garbled output.
const TEXTUAL_APPLICATION_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/yaml',
  'application/x-yaml',
]);
export function classifyMime(mimeType: string): 'text' | 'image' | 'pdf' | 'office' | 'native-doc' | 'unsupported' {
  if (!mimeType) return 'unsupported';
  if (mimeType.startsWith('application/vnd.google-apps.')) return 'native-doc';
  if (mimeType === 'application/pdf') return 'pdf';
  if (isOfficeMime(mimeType)) return 'office';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('text/')) return 'text';
  if (TEXTUAL_APPLICATION_MIMES.has(mimeType)) return 'text';
  return 'unsupported';
}

const GOOGLE_NATIVE_SERVERS: Record<string, string> = {
  'application/vnd.google-apps.document': 'Google Docs',
  'application/vnd.google-apps.spreadsheet': 'Google Sheets',
  'application/vnd.google-apps.presentation': 'Google Slides',
};

// Legacy binary Office formats are readable elsewhere, so route rather than
// give the generic wrong-type message.
const OFFICE_ROUTES: Record<string, string> = {
  'application/vnd.ms-excel':
    'This is a legacy Excel (.xls) file, which cannot be read directly. Open it and use File → Save as Google Sheets first.',
  'application/msword':
    'This is a legacy Word (.doc) file — use the Google Docs MCP server to read it.',
};

const GOOGLE_NATIVE_EXPORT_ONLY: Record<string, string> = {
  'application/vnd.google-apps.drawing': 'a Google Drawing',
  'application/vnd.google-apps.script': 'an Apps Script project',
};


/**
 * Message for a file get_file cannot read. Office and Google-native files are
 * readable by a sibling connector, so they get a pointer to the right server
 * instead of the generic "wrong file type" advice.
 */
export function unsupportedMessage(name: string, mimeType: string, webViewLink: string): string {
  const office = OFFICE_ROUTES[mimeType];
  if (office) return `'${name}': ${office} Open it directly: ${webViewLink}`;

  const service = GOOGLE_NATIVE_SERVERS[mimeType];
  if (service) {
    return `'${name}' is a ${service} file, which get_file cannot read. Use the ${service} MCP server to read its contents, export_file to export it (for example as Markdown or PDF), or open it directly: ${webViewLink}`;
  }
  const exportable = GOOGLE_NATIVE_EXPORT_ONLY[mimeType];
  if (exportable) {
    return `'${name}' is ${exportable}, which get_file cannot read. Use export_file to export it, or open it directly: ${webViewLink}`;
  }
  if (mimeType.startsWith('application/vnd.google-apps.')) {
    return `'${name}' is a Google Drive-native file ('${mimeType}') with no downloadable contents. Open it directly: ${webViewLink}`;
  }
  return `File '${name}' has unsupported mimeType '${mimeType}'. This tool supports text, image, PDF and Office files. Open it directly: ${webViewLink}`;
}

export async function readFileContent(fileId: string, accessToken: string): Promise<Record<string, unknown>> {
  const meta = await makeDriveRequest(
    `/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,webViewLink&supportsAllDrives=true`,
    accessToken
  );

  const mimeType: string = meta.mimeType || '';
  const size = meta.size ? parseInt(meta.size) : 0;
  const name: string = meta.name || '';
  const kind = classifyMime(mimeType);
  const webViewLink: string =
    meta.webViewLink || `https://drive.google.com/file/d/${meta.id}/view`;

  if (kind === 'native-doc' || kind === 'unsupported') {
    return formatDriveError(new Error(unsupportedMessage(name, mimeType, webViewLink)));
  }

  if (size > MAX_FILE_SIZE) {
    return formatDriveError(new Error(
      `File '${name}' is ${size} bytes which exceeds the 20MB limit. ` +
      `Open in browser instead: ${webViewLink}.`
    ));
  }

  const downloadUrl = `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  const response = await fetch(downloadUrl, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new DriveApiError(
      `Failed to download file content${bodyText ? `: ${bodyText}` : ''} (${response.status})`,
      response.status,
    );
  }

  const fileMeta = { id: meta.id, name, mimeType, size, webViewLink };
  const jsonBlock = (payload: unknown) => ({
    type: 'text' as const,
    text: JSON.stringify(payload, null, 2),
  });

  if (kind === 'pdf') {
    const arrayBuffer = await response.arrayBuffer();
    // read before extraction: the PDF parser can detach the buffer
    const bytes = arrayBuffer.byteLength;
    let pdfText: PdfText | undefined;
    let failure: string | undefined;
    const startedAt = Date.now();
    try {
      pdfText = await extractPdfText(new Uint8Array(arrayBuffer));
    } catch (err: any) {
      failure = err?.message || 'the PDF could not be parsed';
      log("error", "pdf_extraction_failed", {
        ...errorFields(err),
        bytes,
        elapsedMs: Date.now() - startedAt,
      });
    }

    let result: Record<string, unknown>;
    if (!pdfText) {
      result = {
        ...fileMeta,
        extraction: 'failed',
        message: `Could not extract text from '${name}' because ${failure}. Open the file directly instead: ${webViewLink}`,
      };
    } else if (pdfText.scanned) {
      result = {
        ...fileMeta,
        extraction: 'scanned',
        pages: pdfText.pages,
        textPages: pdfText.textPages,
        scanned: true,
        message:
          `'${name}' is a scanned (image-only) PDF with ${pdfText.pages} page(s) and no text layer, ` +
          `so there is no text to extract. Reading its contents would require rendering each page as ` +
          `an image, which consumes a large number of tokens and is not supported by this connector. ` +
          `Open the file directly instead: ${webViewLink}`,
      };
    } else {
      const notes: string[] = [];
      if (pdfText.textPages < pdfText.pages) {
        notes.push(
          `only ${pdfText.textPages} of ${pdfText.pages} page(s) carry a text layer; ` +
          `the rest appear to be scanned images and are not included`
        );
      }
      if (pdfText.truncated) {
        notes.push(`the text was truncated at ${MAX_TEXT_CHARS} characters`);
      }
      result = {
        ...fileMeta,
        extraction: 'text',
        content: pdfText.text,
        pages: pdfText.pages,
        textPages: pdfText.textPages,
        ...(pdfText.truncated ? { truncated: true } : {}),
        ...(notes.length
          ? { message: `Note: ${notes.join('; ')}. Full file: ${webViewLink}` }
          : {}),
      };
    }

    return { content: [jsonBlock(result)], structuredContent: result };
  }

  if (kind === 'image') {
    const arrayBuffer = await response.arrayBuffer();
    // Node ≥22 is declared in package.json; Buffer is safe and avoids
    // the O(n²) String.fromCharCode chunking required by btoa.
    const base64Data = Buffer.from(arrayBuffer).toString('base64');
    const imageMeta = { ...fileMeta, extraction: 'image' as const };
    return {
      content: [
        jsonBlock(imageMeta),
        { type: 'image' as const, data: base64Data, mimeType },
      ],
      structuredContent: imageMeta,
    };
  }

  let extracted: { text: string; truncated: boolean };
  if (kind === 'office') {
    const bytes = new Uint8Array(await response.arrayBuffer());
    try {
      extracted = extractOfficeText(bytes, mimeType);
    } catch (err: any) {
      log("error", "office_extraction_failed", { ...errorFields(err), bytes: bytes.length });
      const result = {
        ...fileMeta,
        extraction: 'failed' as const,
        message: `Could not extract text from '${name}' because ${err?.message || 'the file could not be parsed'}. Open the file directly instead: ${webViewLink}`,
      };
      return { content: [jsonBlock(result)], structuredContent: result };
    }
  } else {
    const textContent = await response.text();
    extracted = {
      text: textContent.slice(0, MAX_TEXT_CHARS),
      truncated: textContent.length > MAX_TEXT_CHARS,
    };
  }

  const result = {
    ...fileMeta,
    extraction: 'text' as const,
    content: extracted.text,
    ...(extracted.truncated && {
      truncated: true,
      message: `Note: the text was truncated at ${MAX_TEXT_CHARS} characters. Full file: ${webViewLink}`,
    }),
  };
  return {
    content: [jsonBlock(result)],
    structuredContent: result,
  };
}
