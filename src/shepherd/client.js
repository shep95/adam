/**
 * Shepherd HTTP client: status, model lists, the NDJSON chat stream and image
 * geolocation. The access-gate cookie rides along automatically (same origin).
 */

export class ShepherdHttpError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function readJson(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok)
    throw new ShepherdHttpError(
      body?.error || `HTTP ${response.status}`,
      response.status,
      body,
    );
  return body;
}

/** Split an NDJSON byte stream into parsed events. */
export async function* ndjsonEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line);
        } catch {
          /* torn line — skip */
        }
      }
    }
    const tail = buffer.trim();
    if (tail) {
      try {
        yield JSON.parse(tail);
      } catch {
        /* ignore */
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

export function createShepherdClient({
  fetchImpl = (...a) => globalThis.fetch(...a),
  base = '/api',
} = {}) {
  return {
    async access() {
      return readJson(
        await fetchImpl(`${base}/access`, { credentials: 'same-origin' }),
      );
    },
    async unlock(token) {
      return readJson(
        await fetchImpl(`${base}/access`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        }),
      );
    },
    async status() {
      return readJson(
        await fetchImpl(`${base}/shepherd/status`, {
          credentials: 'same-origin',
        }),
      );
    },
    async models(provider) {
      return readJson(
        await fetchImpl(
          `${base}/shepherd/models?provider=${encodeURIComponent(provider)}`,
          {
            credentials: 'same-origin',
          },
        ),
      );
    },
    async *chat({
      messages,
      console: consoleState,
      provider,
      model,
      task,
      signal,
    }) {
      const response = await fetchImpl(`${base}/shepherd/chat`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages,
          console: consoleState,
          provider,
          model,
          task,
        }),
        signal,
      });
      if (!response.ok || !response.body) await readJson(response);
      yield* ndjsonEvents(response.body);
    },
    async geolocate({ image, hint, provider, signal }) {
      return readJson(
        await fetchImpl(`${base}/shepherd/geolocate`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image, hint, provider }),
          signal,
        }),
      );
    },
    async flightLookup(query, { signal } = {}) {
      return readJson(
        await fetchImpl(
          `${base}/flight-lookup?q=${encodeURIComponent(query)}`,
          {
            credentials: 'same-origin',
            signal,
          },
        ),
      );
    },
  };
}
