/**
 * The one failure type this client throws.
 *
 * The server answers every failure as `{reason_key, params}` (ADR-008 §4, GAP G-33) — a key
 * and the context the catalogue interpolates, never a sentence. This module is what keeps
 * that property intact on this side of the wire: nothing here ever throws a string, and
 * nothing here ever produces prose. A caller translates `error.reasonKey` with
 * `error.params`; it has no other way to render a failure, which is deliberate.
 */

import type { ErrorParams } from "./types";

/**
 * The key used when the failure never reached the application layer.
 *
 * A DNS failure, an aborted socket, a 502 from something in front of the server, or a body
 * that is not the declared `ErrorResponse` shape: all of them are "the request did not get
 * an answer this client can read", and that is one thing to say, not four. It exists in the
 * catalogue already (`error.network`).
 */
export const TRANSPORT_ERROR_KEY = "error.network";

/** Status reported for a failure with no HTTP response at all. */
export const NO_RESPONSE = 0;

export class ApiError extends Error {
  /** The HTTP status, or {@link NO_RESPONSE} when the request never got a response. */
  readonly status: number;
  /** An i18n key. Never a sentence — see the module docstring. */
  readonly reasonKey: string;
  /** What the catalogue entry interpolates: `error.insufficient_funds` says how much short. */
  readonly params: Readonly<ErrorParams>;

  constructor(status: number, reasonKey: string, params: Readonly<ErrorParams> = {}) {
    // `message` carries the key rather than prose so an uncaught error in a console or a
    // stack trace still says which failure it was. It is a developer-facing string, not a
    // user-facing one, and no component should render it.
    super(reasonKey);
    this.name = "ApiError";
    this.status = status;
    this.reasonKey = reasonKey;
    this.params = params;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/**
 * Whether `body` is the declared `{reason_key, params}` shape.
 *
 * `params` is optional and its values are narrowed to `number | string`, because that is what
 * `ErrorResponse` declares and an entry of any other type would be interpolated into a
 * sentence as `[object Object]`. Anything unusable is dropped rather than coerced: a missing
 * placeholder is a visible defect, a plausible-looking wrong one is not.
 */
export function isErrorResponse(body: unknown): body is { reason_key: string; params?: unknown } {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { reason_key?: unknown }).reason_key === "string"
  );
}

export function toErrorParams(value: unknown): ErrorParams {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const params: ErrorParams = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number" || typeof entry === "string") {
      params[key] = entry;
    }
  }
  return params;
}

/**
 * Turn any thrown value into an `ApiError`.
 *
 * Used at the edges — a `fetch` rejection, a `catch` in a mutation — so that a caller's
 * `catch` block has exactly one type to handle and never has to ask whether it was handed a
 * string, a `TypeError`, or a `DOMException`.
 */
export function asApiError(cause: unknown): ApiError {
  if (isApiError(cause)) {
    return cause;
  }
  return new ApiError(NO_RESPONSE, TRANSPORT_ERROR_KEY);
}
