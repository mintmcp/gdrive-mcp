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

export type LabelTaxonomyField = {
  fieldId: string;
  type: string;
  displayName?: string;
  choices?: Array<{ choiceId: string; displayName?: string }>;
};

export type LabelTaxonomyEntry = {
  labelId: string;
  revisionId?: string;
  title?: string;
  fields: LabelTaxonomyField[];
};

export async function listAvailableLabels(
  accessToken: string
): Promise<{ labels: LabelTaxonomyEntry[]; truncated: boolean }> {
  type WireField = {
    id?: string;
    properties?: { displayName?: string };
    selectionOptions?: { choices?: Array<{ id?: string; properties?: { displayName?: string } }> };
    textOptions?: unknown;
    dateOptions?: unknown;
    integerOptions?: unknown;
    userOptions?: unknown;
  };
  type WireLabel = {
    id?: string;
    revisionId?: string;
    properties?: { title?: string };
    fields?: WireField[];
  };

  const fieldType = (f: WireField): string => {
    if (f.selectionOptions) return 'selection';
    if (f.textOptions) return 'text';
    if (f.dateOptions) return 'date';
    if (f.integerOptions) return 'integer';
    if (f.userOptions) return 'user';
    return 'unknown';
  };

  const labels: LabelTaxonomyEntry[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_LABEL_PAGES; page++) {
    const params = new URLSearchParams({ view: 'LABEL_VIEW_FULL', publishedOnly: 'true', pageSize: '100' });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await makeDriveRequest(
      `${DRIVE_LABELS_API}/labels?${params}`,
      accessToken
    ) as { labels?: WireLabel[]; nextPageToken?: string } | null;

    for (const label of data?.labels || []) {
      if (!label.id) continue;
      labels.push({
        labelId: label.id,
        ...(label.revisionId ? { revisionId: label.revisionId } : {}),
        ...(label.properties?.title ? { title: label.properties.title } : {}),
        fields: (label.fields || []).flatMap((f) => f.id === undefined ? [] : [{
          fieldId: f.id,
          type: fieldType(f),
          ...(f.properties?.displayName ? { displayName: f.properties.displayName } : {}),
          ...(f.selectionOptions ? {
            choices: (f.selectionOptions.choices || []).flatMap((c) => c.id === undefined ? [] : [{
              choiceId: c.id,
              ...(c.properties?.displayName ? { displayName: c.properties.displayName } : {}),
            }]),
          } : {}),
        }]),
      });
    }

    pageToken = data?.nextPageToken;
    if (!pageToken) return { labels, truncated: false };
  }
  return { labels, truncated: true };
}

export type LabelFieldInput = {
  field_id: string;
  date_value?: string;
  text_values?: string[];
  integer_values?: string[];
  selection_choice_ids?: string[];
};

/**
 * Validate tool input and build a files.modifyLabels LabelModification.
 * Throws with a caller-actionable message so bad input becomes a tool
 * error before any API call. Empty fields applies the bare label: the
 * API wants fieldModifications absent, not [], for that
 */
export function buildLabelModification(labelId: string, fields: LabelFieldInput[]): Record<string, unknown> {
  const fieldModifications = fields.map((f) => {
    const kinds = [f.date_value, f.text_values, f.integer_values, f.selection_choice_ids]
      .filter((v) => v !== undefined).length;
    if (kinds !== 1) {
      throw new Error(
        `field '${f.field_id}': provide exactly one of date_value, text_values, integer_values, selection_choice_ids (user fields cannot be set by this tool)`
      );
    }
    if (f.date_value !== undefined) {
      // Date round-trips through ISO because V8 normalizes impossible days
      // (2026-02-31 parses as Mar 3 UTC) instead of rejecting them
      const parsed = new Date(`${f.date_value}T00:00:00Z`);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(f.date_value) ||
        Number.isNaN(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== f.date_value
      ) {
        throw new Error(`field '${f.field_id}': date_value must be a valid YYYY-MM-DD date`);
      }
      return { fieldId: f.field_id, setDateValues: [f.date_value] };
    }
    if (f.text_values !== undefined) {
      if (f.text_values.length === 0) {
        throw new Error(`field '${f.field_id}': text_values must not be empty`);
      }
      return { fieldId: f.field_id, setTextValues: f.text_values };
    }
    if (f.integer_values !== undefined) {
      if (f.integer_values.length === 0) {
        throw new Error(`field '${f.field_id}': integer_values must not be empty`);
      }
      for (const v of f.integer_values) {
        if (!/^-?\d+$/.test(v)) {
          throw new Error(`field '${f.field_id}': integer_values entries must be whole numbers, got '${v}'`);
        }
      }
      return { fieldId: f.field_id, setIntegerValues: f.integer_values };
    }
    const choiceIds = f.selection_choice_ids ?? [];
    if (choiceIds.length === 0) {
      throw new Error(`field '${f.field_id}': selection_choice_ids must not be empty`);
    }
    return { fieldId: f.field_id, setSelectionValues: choiceIds };
  });
  return {
    labelId,
    ...(fieldModifications.length ? { fieldModifications } : {}),
  };
}

export async function modifyFileLabels(
  fileId: string,
  accessToken: string,
  labelModification: Record<string, unknown>
): Promise<Array<Record<string, unknown>>> {
  const result = await makeDriveRequest(
    `/files/${encodeURIComponent(fileId)}/modifyLabels`,
    accessToken,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelModifications: [labelModification] }),
    }
  );
  // A 2xx with an empty or non-JSON body must not read as a clean no-op
  if (result === null || typeof result !== 'object') {
    throw new Error(`modifyLabels returned an unexpected response: ${String(result).slice(0, 200)}`);
  }
  // Google omits empty arrays, so a missing key is a legitimate no-op
  return Array.isArray(result.modifiedLabels) ? result.modifiedLabels : [];
}
