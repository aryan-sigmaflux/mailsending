/**
 * API client for the FastAPI backend. Tokens live in localStorage (same pattern as the Sigmaflux CRM).
 */

export const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8010/api/v1";

const ACCESS = "sfm_access";
const REFRESH = "sfm_refresh";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const tokens = {
  access: () => (typeof window === "undefined" ? null : localStorage.getItem(ACCESS)),
  refresh: () => (typeof window === "undefined" ? null : localStorage.getItem(REFRESH)),
  save(access: string, refresh: string) {
    localStorage.setItem(ACCESS, access);
    localStorage.setItem(REFRESH, refresh);
  },
  clear() {
    localStorage.removeItem(ACCESS);
    localStorage.removeItem(REFRESH);
  },
};

let refreshing: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  const rt = tokens.refresh();
  if (!rt) return false;
  refreshing ??= fetch(`${BASE_URL}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: rt }),
  })
    .then(async (r) => {
      if (!r.ok) return false;
      const data = await r.json();
      tokens.save(data.access_token, data.refresh_token);
      return true;
    })
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

function errorMessage(body: unknown): string {
  const detail = (body as { detail?: unknown })?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail.length) {
    const d = detail[0] as { msg?: string; loc?: string[] };
    const field = d.loc?.slice(-1)[0];
    return `${field ? `${field}: ` : ""}${d.msg ?? "Invalid input"}`;
  }
  return "Something went wrong";
}

export async function api<T = unknown>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
    ...(options.headers as Record<string, string>),
  };
  const t = tokens.access();
  if (t) headers.Authorization = `Bearer ${t}`;

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  } catch {
    throw new ApiError(0, "Can't reach the server — is the API running?");
  }

  if (res.status === 401 && retry && (await tryRefresh())) return api<T>(path, options, false);
  if (res.status === 401) {
    tokens.clear();
    if (typeof window !== "undefined" && !location.pathname.startsWith("/login")) location.href = "/login";
  }
  if (!res.ok) throw new ApiError(res.status, errorMessage(await res.json().catch(() => ({}))));
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const get = <T>(p: string) => api<T>(p);
export const post = <T>(p: string, body?: unknown) =>
  api<T>(p, { method: "POST", body: body instanceof FormData ? body : JSON.stringify(body ?? {}) });
export const put = <T>(p: string, body: unknown) => api<T>(p, { method: "PUT", body: JSON.stringify(body) });
export const patch = <T>(p: string, body: unknown) => api<T>(p, { method: "PATCH", body: JSON.stringify(body) });
export const del = <T = void>(p: string) => api<T>(p, { method: "DELETE" });
