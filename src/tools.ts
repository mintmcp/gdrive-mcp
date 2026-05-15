/**
 * Google Drive MCP Tools
 */

import { z } from 'zod';
import { withGoogleAuth as requirePermissionSecure } from "./auth.js";

const GOOGLE_DRIVE_API = 'https://www.googleapis.com/drive/v3';
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const SUPPORTED_MIME_TYPES = [
  // Text
  'text/plain',
  'text/csv',
  'text/html',
  'text/xml',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/yaml',
  // Images
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  // Documents
  'application/pdf',
] as const;

/**
 * Helper to make authenticated requests to Google Drive API
 */
async function makeDriveRequest(
  endpoint: string,
  accessToken: string,
  options: RequestInit = {}
): Promise<any> {
  const url = endpoint.startsWith('http') ? endpoint : `${GOOGLE_DRIVE_API}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMessage = `Google Drive API error (${response.status})`;

    try {
      const errorJson = JSON.parse(errorText);
      const error = errorJson.error;
      if (error) {
        const details = error.errors?.map((e: any) =>
          [e.message, e.reason, e.location].filter(Boolean).join(' - ')
        ).join('; ');
        errorMessage = `${error.message}${details ? `: ${details}` : ''} (${response.status})`;
      }
    } catch {
      errorMessage = errorText || errorMessage;
    }

    throw new Error(errorMessage);
  }

  return response.json();
}

// Reusable output schema fragments — tolerant (all leaves optional, passthrough outer)
const driveFileSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
  createdTime: z.string().optional(),
  modifiedTime: z.string().optional(),
  parents: z.array(z.string()).optional(),
  webViewLink: z.string().optional(),
  owner: z.string().optional(),
  isFolder: z.boolean().optional(),
}).passthrough();

/**
 * Google Drive Tools class following the same pattern as GoogleCalendarTools
 */
export class GoogleDriveTools {
  static getTools() {
    return {
      search_files: {
        description: 'Search for files and folders in Google Drive using flexible search operators. Supports filtering by name, owner, file type, date, starred status, and more.',
        readOnlyHint: true,
        outputSchema: {
          files: z.array(driveFileSchema),
          nextPageToken: z.string().nullable(),
        },
        schema: {
          query: z.string().describe(`Google Drive API q parameter. Uses Drive query syntax:
- name contains 'budget' and trashed = false
- 'user@example.com' in owners and trashed = false
- mimeType = 'application/vnd.google-apps.document' and modifiedTime > '2025-01-01T00:00:00'
- mimeType = 'application/pdf' and trashed = false
- sharedWithMe and trashed = false
- starred = true and trashed = false
- 'FOLDER_ID' in parents and trashed = false
Operators: name, mimeType, modifiedTime, createdTime, owners, writers, readers, starred, trashed, sharedWithMe, parents.
Comparisons: contains, =, !=, <, >, <=, >=. Combine with: and, or, not.
Always include "trashed = false" unless searching trash.`),
          page_token: z.string().optional().describe('Token for fetching the next page of results'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/drive.readonly", async ({ query, page_token }: any, context: any) => {
          const { accessToken } = context;

          const params = new URLSearchParams({
            pageSize: '20',
            fields: 'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,parents,webViewLink,owners)',
            supportsAllDrives: 'true',
            includeItemsFromAllDrives: 'true',
            q: query,
            ...(page_token && { pageToken: page_token }),
          });

          let result;
          try {
            result = await makeDriveRequest(
              `/files?${params}`,
              accessToken
            );
          } catch (error: any) {
            if (error.message?.includes('Invalid') || error.message?.includes('400')) {
              throw new Error(
                `Invalid query syntax. The query parameter must use Google Drive API query format. ` +
                `You sent: "${query}". ` +
                `Examples of valid queries: name contains 'test' and trashed = false, ` +
                `'user@example.com' in owners and trashed = false, ` +
                `mimeType = 'application/pdf' and trashed = false`
              );
            }
            throw error;
          }

          // Format the response
          const files = result.files || [];
          const formattedFiles = files.map((file: any) => ({
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            size: file.size ? parseInt(file.size) : undefined,
            createdTime: file.createdTime,
            modifiedTime: file.modifiedTime,
            parents: file.parents,
            webViewLink: file.webViewLink,
            owner: file.owners?.[0]?.emailAddress,
            isFolder: file.mimeType === 'application/vnd.google-apps.folder',
          }));

          const output = {
            files: formattedFiles,
            nextPageToken: result.nextPageToken || null
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
            structuredContent: output,
          };
        }),
      },

      copy_file: {
        description: 'Copy a file in Google Drive',
        outputSchema: {
          id: z.string(),
          name: z.string(),
          mimeType: z.string(),
          size: z.number().optional(),
          createdTime: z.string().optional(),
          modifiedTime: z.string().optional(),
          parents: z.array(z.string()).optional(),
          webViewLink: z.string().optional(),
          message: z.string(),
        },
        schema: {
          file_id: z.string().describe('ID of the file to copy'),
          name: z.string().optional().describe('New name for the copied file'),
          parent_folder_id: z.string().optional().describe('ID of the folder to place the copy in'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/drive.file", async ({ file_id, name, parent_folder_id }: any, context: any) => {
          const { accessToken } = context;

          const requestBody: any = {};

          if (name) {
            requestBody.name = name;
          }

          if (parent_folder_id) {
            requestBody.parents = [parent_folder_id];
          }

          const result = await makeDriveRequest(
            `/files/${encodeURIComponent(file_id)}/copy?supportsAllDrives=true`,
            accessToken,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(requestBody),
            }
          );

          const output = {
            id: result.id,
            name: result.name,
            mimeType: result.mimeType,
            size: result.size ? parseInt(result.size) : undefined,
            createdTime: result.createdTime,
            modifiedTime: result.modifiedTime,
            parents: result.parents,
            webViewLink: result.webViewLink,
            message: `File copied successfully`,
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
            structuredContent: output,
          };
        }),
      },

      create_folder: {
        description: 'Create a folder in Google Drive',
        outputSchema: {
          id: z.string(),
          name: z.string(),
          mimeType: z.string(),
          createdTime: z.string().optional(),
          modifiedTime: z.string().optional(),
          parents: z.array(z.string()).optional(),
          webViewLink: z.string().optional(),
          message: z.string(),
        },
        schema: {
          name: z.string().describe('Name of the folder to create'),
          parent_folder_id: z.string().optional().describe('ID of the parent folder'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/drive.file", async ({ name, parent_folder_id }: any, context: any) => {
          const { accessToken } = context;

          const requestBody: any = {
            name: name,
            mimeType: 'application/vnd.google-apps.folder',
          };

          if (parent_folder_id) {
            requestBody.parents = [parent_folder_id];
          }

          const result = await makeDriveRequest(
            '/files?supportsAllDrives=true',
            accessToken,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(requestBody),
            }
          );

          const output = {
            id: result.id,
            name: result.name,
            mimeType: result.mimeType,
            createdTime: result.createdTime,
            modifiedTime: result.modifiedTime,
            parents: result.parents,
            webViewLink: result.webViewLink,
            message: 'Folder created successfully',
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
            structuredContent: output,
          };
        }),
      },

      get_file: {
        description: 'Get the content of a file from Google Drive. Supports text files, images, and PDFs up to 20MB. Does not support Google Docs/Sheets/Slides — use the dedicated MCP servers for those.',
        readOnlyHint: true,
        outputSchema: {
          id: z.string().optional(),
          name: z.string().optional(),
          mimeType: z.string().optional(),
          size: z.number().optional(),
          content: z.string().optional(),
        },
        schema: {
          file_id: z.string().describe('The Google Drive file ID'),
          mime_type: z.enum(SUPPORTED_MIME_TYPES).describe('The MIME type of the file. Use search_files to find this.'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/drive.readonly", async ({ file_id, mime_type }: any, context: any) => {
          const { accessToken } = context;

          // 1. Fetch metadata
          const meta = await makeDriveRequest(
            `/files/${encodeURIComponent(file_id)}?fields=id,name,mimeType,size,webViewLink,webContentLink&supportsAllDrives=true`,
            accessToken
          );

          const mimeType: string = meta.mimeType || '';
          const size = meta.size ? parseInt(meta.size) : 0;
          const name: string = meta.name || '';

          // Size check
          if (size > MAX_FILE_SIZE) {
            return {
              content: [{ type: 'text' as const, text: `File '${name}' exceeds the 20MB limit. Download it directly: ${meta.webContentLink || meta.webViewLink}` }],
            };
          }

          // Fetch content
          const downloadUrl = `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(file_id)}?alt=media&supportsAllDrives=true`;
          const response = await fetch(downloadUrl, {
            headers: { 'Authorization': `Bearer ${accessToken}` },
          });

          if (!response.ok) {
            throw new Error(`Failed to download file (${response.status})`);
          }

          if (mime_type.startsWith('image/') || mime_type === 'application/pdf') {
            const arrayBuffer = await response.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            const base64Data = btoa(binary);

            if (mime_type === 'application/pdf') {
              return {
                content: [
                  { type: 'text' as const, text: JSON.stringify({ id: meta.id, name, mimeType, size }, null, 2) },
                  {
                    type: 'resource' as const,
                    resource: {
                      uri: `gdrive://file/${meta.id}`,
                      mimeType,
                      blob: base64Data,
                    },
                  },
                ],
              };
            }

            return {
              content: [
                { type: 'image' as const, data: base64Data, mimeType },
              ],
            };
          }

          const textContent = await response.text();
          const result = { id: meta.id, name, mimeType, size, content: textContent };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          };
        }),
      },
    };
  }
}
