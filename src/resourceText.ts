// Text helpers shared by the resources/read branches: code fences, the D10
// truncation with its note, the D9 details-only text, and type names

import { MAX_TEXT_CHARS } from './limits.js';

// What one resources/read reader produces: the text, or the reason for a D9
// details-only text instead
export type TextRead = { text: string } | { detailsOnly: string };

// A fence longer than any backtick run in the text, so the text can't close it
export function codeFence(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

// Cut without leaving half of a surrogate pair at the end
export function sliceChars(text: string, length: number): string {
  if (length <= 0) return '';
  if (length >= text.length) return text;
  const code = text.charCodeAt(length - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length);
}

export function stripBom(text: string): string {
  return text.replace(/^﻿/, '');
}

/**
 * D10: the body plus its notes, within MAX_TEXT_CHARS. When they don't fit,
 * the body is cut to the limit minus the notes and a truncation note with the
 * link. `truncated` adds that note even when the body was already cut upstream
 */
export function capText(
  body: string,
  link: string,
  options: { notes?: string[]; truncated?: boolean; max?: number } = {},
): string {
  const max = options.max ?? MAX_TEXT_CHARS;
  const notes = options.notes ?? [];
  const tail = notes.length ? `\n\n${notes.join('\n\n')}` : '';
  if (!options.truncated && body.length + tail.length <= max) return body + tail;

  // The kept length is in the note, so size the note for the largest number it
  // could show first
  const note = (kept: number) => `\n\n[Truncated at ${kept} characters. Full file: ${link}]`;
  const room = Math.max(0, max - tail.length - note(max).length);
  const kept = sliceChars(body, room);
  return kept + note(kept.length) + tail;
}

const TYPE_NAMES: Record<string, string> = {
  'application/vnd.google-apps.folder': 'Google Drive folder',
  'application/vnd.google-apps.document': 'Google Doc',
  'application/vnd.google-apps.spreadsheet': 'Google Sheet',
  'application/vnd.google-apps.presentation': 'Google Slides deck',
  'application/vnd.google-apps.form': 'Google Form',
  'application/vnd.google-apps.drawing': 'Google Drawing',
  'application/vnd.google-apps.site': 'Google Site',
  'application/vnd.google-apps.script': 'Apps Script project',
  'application/vnd.google-apps.shortcut': 'Drive shortcut',
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word document',
  'application/msword': 'Word document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel spreadsheet',
  'application/vnd.ms-excel': 'Excel spreadsheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint presentation',
  'application/vnd.ms-powerpoint': 'PowerPoint presentation',
};

// A human name for a Drive mimeType, falling back to the mimeType itself
export function typeName(mimeType: string): string {
  if (TYPE_NAMES[mimeType]) return TYPE_NAMES[mimeType];
  if (mimeType.startsWith('image/')) return `image (${mimeType})`;
  if (mimeType.startsWith('video/')) return `video (${mimeType})`;
  if (mimeType.startsWith('audio/')) return `audio (${mimeType})`;
  if (mimeType.startsWith('application/vnd.google-apps.')) return `Google Drive item (${mimeType})`;
  return mimeType || 'file of unknown type';
}

const MAX_NAME_CHARS = 1_000;

/**
 * D9: what a read returns instead of content it can't include (too big,
 * scanned, extraction failed). Name, type, size, link and why, as Markdown
 */
export function detailsOnlyText(file: {
  name: string;
  mimeType: string;
  size?: number;
  link: string;
  why: string;
}): string {
  const lines = [
    `# ${sliceChars(file.name, MAX_NAME_CHARS)}`,
    '',
    `${file.why} The content isn't included here. Open the file to read it: ${file.link}`,
    '',
    `- Type: ${typeName(file.mimeType)}`,
    ...(file.size !== undefined ? [`- Size: ${file.size} bytes`] : []),
    `- Link: ${file.link}`,
  ];
  return sliceChars(lines.join('\n'), MAX_TEXT_CHARS);
}
