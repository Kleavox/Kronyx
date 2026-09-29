export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    code?: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function readApiResponse<T = unknown>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  > & {
    code?: string;
    message?: string;
  };
  if (!response.ok) {
    throw new ApiError(
      payload.message || "The request could not be completed.",
      response.status,
      payload.code,
      payload,
    );
  }
  return payload as T;
}

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const declaresJson = init.body !== undefined || !BODYLESS_METHODS.has(method);
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      ...(declaresJson ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  return readApiResponse<T>(response);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed.";
}
