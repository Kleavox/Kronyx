import { ApiError } from "./http";

export function isSessionLost(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.status === 401 || error.status === 403)
  );
}
