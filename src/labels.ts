import { makeDriveRequest } from './driveApi.js';
import { grantedScopes, SCOPES } from './scopes.js';

const DRIVE_LABELS_API = 'https://drivelabels.googleapis.com/v2';
const MAX_LABEL_PAGES = 10; // 1000 labels at maxResults=100, far above Drive's per-file limit
const MAX_TEXT_LABEL_CHARS = 256; // text fields are free form, cap what reaches the consumer

export type LabelChoices = Record<string, Record<string, string>>;

export type AppliedLabelValue =
  | { fieldId: string; valueType: 'selection'; choiceId: string; displayName?: string; resolved: boolean }
  | { fieldId: string; valueType: 'text'; value: string }
  | { fieldId: string; valueType: 'date'; value: string }
  | { fieldId: string; valueType: 'integer'; value: string };

// user fields are withheld (PII)
export type SkippedValueType = 'user' | 'emptyText' | 'truncatedText' | 'unsupported';

export type AppliedLabel = {
  labelId: string;
  revisionId?: string;
  title?: string;
  resolved: boolean;
  values: AppliedLabelValue[];
  skippedValueTypes?: SkippedValueType[];
};

export type FileLabels = {
  applied: AppliedLabel[];
  error?: 'label read failed' | 'incomplete label resolution';
};

// pinned to the applied revision so a later rename can't change how an
// already-labeled file resolves; never cached, tokens differ per request
export async function getLabelInfo(
  labelId: string,
  revisionId: string | undefined,
  accessToken: string
): Promise<{ title?: string; choices: LabelChoices }> {
  const labelResource = revisionId
    ? `${encodeURIComponent(labelId)}@${encodeURIComponent(revisionId)}`
    : encodeURIComponent(labelId);

  const data = await makeDriveRequest(
    `${DRIVE_LABELS_API}/labels/${labelResource}?view=LABEL_VIEW_FULL`,
    accessToken
  ) as {
    properties?: { title?: string };
    fields?: Array<{
      id: string;
      selectionOptions?: { choices?: Array<{ id: string; properties?: { displayName?: string } }> };
    }>;
  };

  const choices: LabelChoices = {};
  for (const field of data?.fields || []) {
    const fieldChoices = field.selectionOptions?.choices;
    if (!fieldChoices) continue;
    const names: Record<string, string> = {};
    for (const choice of fieldChoices) {
      if (choice.properties?.displayName) {
        names[choice.id] = choice.properties.displayName;
      }
    }
    choices[field.id] = names;
  }

  return { title: data?.properties?.title, choices };
}

// informs, never blocks: failures become a stable error code alongside
// whatever was read; policy should match ids, names are for humans
export async function getFileLabels(
  fileId: string,
  accessToken: string
): Promise<FileLabels> {
  type WireLabel = {
    id?: string;
    revisionId?: string;
    fields?: Record<string, {
      valueType?: string;
      selection?: string[];
      text?: string[];
      dateString?: string[];
      integer?: string[];
    }>;
  };

  const wire: WireLabel[] = [];
  let error: FileLabels['error'];

  try {
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_LABEL_PAGES; page++) {
      const params = new URLSearchParams({ maxResults: '100' });
      if (pageToken) params.set('pageToken', pageToken);
      const pageData = await makeDriveRequest(
        `/files/${encodeURIComponent(fileId)}/listLabels?${params}`,
        accessToken
      ) as { labels?: WireLabel[]; nextPageToken?: string };
      if (pageData?.labels) wire.push(...pageData.labels);
      pageToken = pageData?.nextPageToken;
      if (!pageToken) break;
    }
    if (pageToken) {
      error = 'label read failed';
      console.warn(`getFileLabels: page cap hit fileId=${fileId}`);
    }
  } catch (err: any) {
    error = 'label read failed';
    console.warn(`getFileLabels: label read failed fileId=${fileId} error=${err?.message}`);
  }

  const withIds = wire.filter((l): l is WireLabel & { id: string } => {
    if (l.id) return true;
    if (!error) error = 'incomplete label resolution';
    console.warn(`getFileLabels: applied label without id fileId=${fileId}`);
    return false;
  });

  const lookups = await Promise.allSettled(
    withIds.map((l) => getLabelInfo(l.id, l.revisionId, accessToken))
  );

  const applied: AppliedLabel[] = withIds.map((label, i) => {
    const lookup = lookups[i];
    const info = lookup.status === 'fulfilled' ? lookup.value : undefined;
    if (!info) {
      if (!error) error = 'incomplete label resolution';
      console.warn(
        `getFileLabels: label lookup failed fileId=${fileId} labelId=${label.id} ` +
        `error=${(lookup as PromiseRejectedResult).reason?.message}`
      );
    }

    const values: AppliedLabelValue[] = [];
    const skippedTypes = new Set<SkippedValueType>();
    let unresolvedChoice = false;

    for (const [fieldId, field] of Object.entries(label.fields || {})) {
      if (field.valueType === 'text' && field.text) {
        for (const raw of field.text) {
          if (!raw) {
            skippedTypes.add('emptyText');
            continue;
          }
          if (raw.length > MAX_TEXT_LABEL_CHARS) skippedTypes.add('truncatedText');
          values.push({ fieldId, valueType: 'text', value: raw.slice(0, MAX_TEXT_LABEL_CHARS) });
        }
      } else if (field.valueType === 'dateString' && field.dateString?.length) {
        for (const value of field.dateString) {
          values.push({ fieldId, valueType: 'date', value });
        }
      } else if (field.valueType === 'integer' && field.integer?.length) {
        for (const value of field.integer) {
          values.push({ fieldId, valueType: 'integer', value: String(value) });
        }
      } else if (field.valueType === 'selection' && field.selection?.length) {
        for (const choiceId of field.selection) {
          const displayName = info?.choices[fieldId]?.[choiceId];
          if (info && displayName === undefined) unresolvedChoice = true;
          values.push({
            fieldId,
            valueType: 'selection',
            choiceId,
            ...(displayName !== undefined ? { displayName } : {}),
            resolved: displayName !== undefined,
          });
        }
      } else if (field.valueType === 'user') {
        skippedTypes.add('user');
      } else {
        skippedTypes.add('unsupported');
      }
    }

    if (unresolvedChoice) {
      if (!error) error = 'incomplete label resolution';
      console.warn(`getFileLabels: unresolved choice fileId=${fileId} labelId=${label.id}`);
    }

    return {
      labelId: label.id,
      ...(label.revisionId ? { revisionId: label.revisionId } : {}),
      ...(info?.title !== undefined ? { title: info.title } : {}),
      resolved: info !== undefined,
      values,
      ...(skippedTypes.size ? { skippedValueTypes: [...skippedTypes] } : {}),
    };
  });

  return {
    applied,
    ...(error ? { error } : {}),
  };
}

// null when the grant lacks drive.labels.readonly: no label calls, no _meta,
// meaning "surfacing not enabled", never "no labels". Never rejects
export function fetchLabelsMeta(fileId: string, accessToken: string): Promise<Record<string, unknown>> | null {
  const granted = grantedScopes();
  if (granted !== null && !granted.has(SCOPES.DRIVE_LABELS_READONLY)) return null;
  return getFileLabels(fileId, accessToken).then(({ applied, error }) => ({
    applied,
    ...(error ? { labelsError: error } : {}),
  }));
}
