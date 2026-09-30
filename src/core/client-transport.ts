import type { Transport } from "./contracts.ts";

export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class ClientTransportError extends Error {
    readonly code: "response_too_large" | "invalid_response_encoding";
    constructor(code: "response_too_large" | "invalid_response_encoding") {
        super(code);
        this.code = code;
        this.name = "ClientTransportError";
    }
}

/** The caller supplies only an approved request; redirects never forward its credential. */
export const fetchTransport: Transport = async (request) => {
    const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: request.signal,
        redirect: "manual",
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
        headers[name] = value;
    });
    if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return { status: response.status, headers, body: "" };
    }
    const length = response.headers.get("content-length");
    if (length && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
        try {
            await response.body?.cancel();
        } finally {
            throw new ClientTransportError("response_too_large");
        }
    }
    if (!response.body) return { status: response.status, headers, body: "" };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) {
                try {
                    await reader.cancel();
                } finally {
                    throw new ClientTransportError("response_too_large");
                }
            }
            chunks.push(chunk.value);
        }
    } finally {
        reader.releaseLock();
    }
    let body: string;
    try {
        body = new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks, bytes),
        );
    } catch {
        throw new ClientTransportError("invalid_response_encoding");
    }
    return { status: response.status, headers, body };
};
