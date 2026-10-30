export const json = (body: unknown, status = 200) => Response.json(body, { status });

export const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

// body ว่าง = {} (เช่น POST ที่ไม่ต้องส่งข้อมูล), JSON ผิดรูป / ไม่ใช่ object = null
export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
	try {
		const text = await req.text();
		if (!text) return {};
		const body = JSON.parse(text);
		return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

export type Body = Record<string, unknown>;

export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		readonly field?: string,
	) {
		super(code);
	}
}
export const badField = (field: string) => new HttpError(400, "BAD_REQUEST", field);
export const notFound = () => new HttpError(404, "NOT_FOUND");

export const isUniqueViolation = (err: unknown) => String(err).includes("UNIQUE constraint failed");

export function reqStr(body: Body, name: string, max: number): string {
	const v = body[name];
	if (!isStr(v, max)) throw badField(name);
	return v;
}

// undefined = ไม่ได้ส่งมา (ไม่แก้), null = ล้างค่า
export function optStr(body: Body, name: string, max: number): string | null | undefined {
	const v = body[name];
	if (v === undefined || v === null) return v;
	if (!isStr(v, max)) throw badField(name);
	return v;
}

export function optEnum(body: Body, name: string, allowed: readonly string[]): string | undefined {
	const v = body[name];
	if (v === undefined) return undefined;
	if (typeof v !== "string" || !allowed.includes(v)) throw badField(name);
	return v;
}

export function reqEnum(body: Body, name: string, allowed: readonly string[]): string {
	const v = optEnum(body, name, allowed);
	if (v === undefined) throw badField(name);
	return v;
}

export function optBool(body: Body, name: string): boolean | undefined {
	const v = body[name];
	if (v === undefined) return undefined;
	if (typeof v !== "boolean") throw badField(name);
	return v;
}

// HttpError -> JSON response; error อื่นโยนต่อ
export function errorResponse(err: unknown): Response {
	if (err instanceof HttpError) return json({ error: err.code, field: err.field }, err.status);
	if (isUniqueViolation(err)) return json({ error: "CONFLICT" }, 409);
	throw err;
}
