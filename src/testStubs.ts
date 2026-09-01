import { vi } from 'vitest';

// fetch stub routing by URL substring, in order; unmatched URLs fail the test
export function stubFetch(routes: Array<[string, (url: string) => Response]>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    for (const [substr, handler] of routes) {
      if (url.includes(substr)) return handler(url);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
  return calls;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const LABEL_SCHEMA_BODY = {
  fields: [
    {
      id: 'field1',
      selectionOptions: {
        choices: [
          { id: 'choiceA', properties: { displayName: 'Confidential' } },
          { id: 'choiceB', properties: { displayName: 'Internal' } },
          { id: 'choiceNoName', properties: {} },
        ],
      },
    },
    { id: 'textField' }, // non-selection field, no choices to map
  ],
};

