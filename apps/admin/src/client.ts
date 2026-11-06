/** Same-origin API client. Its credential remains only in this tab's memory. */
export class AdminClient {
    private token = "";
    /** Replace the credential without browser persistence or URL parameters. */
    public authenticate(token: string): void {
        this.token = token.trim();
    }
    /** Clear the credential when leaving the session. */
    public disconnect(): void {
        this.token = "";
    }
    /** Send a management request, preserving structured errors and the diagnostic request ID. */
    public async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
        if (!path.startsWith("/v1/")) throw new Error("Management requests must remain under /v1/");
        const response = await fetch(path, {
            method,
            credentials: "omit",
            cache: "no-store",
            headers: {
                authorization: `Bearer ${this.token}`,
                ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (response.status === 204) return undefined as T;
        const data: unknown = await response.json();
        if (!response.ok) {
            const error = data as { error?: { code?: string; message?: string; requestId?: string } };
            throw new AdminApiError(
                response.status,
                error.error?.code ?? "REQUEST_FAILED",
                error.error?.message ?? "La requête a échoué",
                error.error?.requestId,
            );
        }
        return data as T;
    }
}
/** A structured API failure, including optimistic version conflicts. */
export class AdminApiError extends Error {
    public constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
        public readonly requestId?: string,
    ) {
        super(message);
        this.name = "AdminApiError";
    }
}
