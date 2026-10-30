export const JWT_ISS = "aaa";

const enc = new TextEncoder();

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

const b64url = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const hmacKey = (secret: string) =>
	crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

export async function sha256Hex(value: string): Promise<string> {
	return toHex(await crypto.subtle.digest("SHA-256", enc.encode(value)));
}

export async function hmacHex(secret: string, value: string): Promise<string> {
	return toHex(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(value)));
}

export function safeEqual(a: string, b: string): boolean {
	const x = enc.encode(a);
	const y = enc.encode(b);
	return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

export interface TokenClaims {
	iss: string;
	aud: string;
	sub: string; // device_id หรือ admin_id
	pid: string; // project_id
	scope: string;
	iat: number;
	exp: number;
}

const JWT_HEADER = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));

export async function signJwt(secret: string, claims: TokenClaims): Promise<string> {
	const body = `${JWT_HEADER}.${b64url(enc.encode(JSON.stringify(claims)))}`;
	const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
	return `${body}.${b64url(new Uint8Array(sig))}`;
}

// คืน claims เมื่อ signature, iss, aud และ exp ถูกต้องเท่านั้น
export async function verifyJwt(secret: string, token: string, iss: string, aud: string): Promise<TokenClaims | null> {
	const parts = token.split(".");
	// รับเฉพาะ header ที่เราออกเองเท่านั้น กัน alg confusion
	if (parts.length !== 3 || parts[0] !== JWT_HEADER) return null;
	try {
		const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
		if (!ok) return null;
		const claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]))) as TokenClaims;
		if (claims.iss !== iss || claims.aud !== aud || typeof claims.exp !== "number") return null;
		return claims.exp > Math.floor(Date.now() / 1000) ? claims : null;
	} catch {
		return null;
	}
}

// PBKDF2 ของ Workers รับได้สูงสุด 100,000 iterations
const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2Hex(password: string, salt: Uint8Array, iterations: number): Promise<string> {
	const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
	return toHex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

// รูปแบบ: pbkdf2_sha256$<iterations>$<salt hex>$<hash hex> (ต้องตรงกับ scripts/hash-password.mjs)
export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${toHex(salt.buffer)}$${await pbkdf2Hex(password, salt, PBKDF2_ITERATIONS)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [algo, iter, saltHex, hash] = stored.split("$");
	const iterations = Number(iter);
	if (algo !== "pbkdf2_sha256" || !(iterations > 0 && iterations <= PBKDF2_ITERATIONS) || !saltHex || !hash) return false;
	const salt = Uint8Array.from(saltHex.match(/../g) ?? [], (h) => parseInt(h, 16));
	return safeEqual(await pbkdf2Hex(password, salt, iterations), hash);
}
