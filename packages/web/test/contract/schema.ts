/**
 * A small JSON Schema validator for the subset the generated definitions use
 * (draft 2020-12, plus OpenAPI 3.0's `nullable` and draft 4's tuple and
 * size limits). It exists so that a value known to be valid can be checked
 * against a schema without adding a dependency: the typed examples and the
 * backend's real answers are checked against the generated schemas.
 *
 * OpenAPI 3.0 has one way to say that a referenced type may also be null:
 * `anyOf: [{ $ref }, { nullable: true }]`. A schema with `nullable: true` and
 * nothing else is read here as "is null", which is what that alternative means.
 */

export interface Schema {
	$ref?: string;
	type?: string | string[];
	enum?: unknown[];
	const?: unknown;
	properties?: Record<string, Schema>;
	required?: string[];
	items?: Schema | boolean | Schema[];
	prefixItems?: Schema[];
	minItems?: number;
	maxItems?: number;
	additionalProperties?: Schema | boolean;
	anyOf?: Schema[];
	allOf?: Schema[];
	oneOf?: Schema[];
	not?: Schema;
	nullable?: boolean;
	description?: string;
	deprecated?: boolean;
	format?: string;
	title?: string;
	default?: unknown;
	examples?: unknown[];
	minimum?: number;
	maximum?: number;
	exclusiveMinimum?: number;
	maxLength?: number;
	[key: string]: unknown;
}

/** A JSON Schema document whose definitions are under `$defs`, or the components of an OpenAPI document. */
export interface SchemaSource {
	$defs?: Record<string, Schema>;
	definitions?: Record<string, Schema>;
	components?: { schemas?: Record<string, Schema> };
}

/** The keyword `format` says nothing here about validity: values are checked by type only. */
const TYPE_OF: Record<string, (value: unknown) => boolean> = {
	string: (value) => typeof value === "string",
	integer: (value) => typeof value === "number" && Number.isInteger(value),
	number: (value) => typeof value === "number" && Number.isFinite(value),
	boolean: (value) => typeof value === "boolean",
	object: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
	array: Array.isArray,
	null: (value) => value === null,
};

/** What may stand on the alternative that only says null. */
const NULL_ONLY = new Set(["nullable", "description", "title", "default", "example", "examples", "deprecated"]);

/** Where a `$ref` points inside `source`, by the names of its document. */
export function resolveReference(ref: string, source: SchemaSource): Schema | undefined {
	const pointer = ref.split("/").slice(1);
	let node: unknown = source;
	for (const name of pointer)
		node = (node as Record<string, unknown> | undefined)?.[name.replaceAll("~1", "/").replaceAll("~0", "~")];
	return node && typeof node === "object" ? (node as Schema) : undefined;
}

/** Every way `value` does not conform to `schema`, as a path and a reason. An empty list means it conforms. */
export function validate(schema: Schema, value: unknown, source: SchemaSource, path = "$", depth = 0): string[] {
	if (depth > 200) return [`${path}: nesting deeper than 200`];
	if (schema.$ref) {
		const target = resolveReference(schema.$ref, source);
		if (!target) return [`${path}: unresolved reference ${schema.$ref}`];
		// Sibling keywords next to a reference are still meant.
		const { $ref: _ref, ...rest } = schema;
		return validate(target, value, source, path, depth + 1).concat(
			Object.keys(rest).length === 0 ? [] : validate(rest as Schema, value, source, path, depth + 1),
		);
	}
	const failures: string[] = [];
	if (schema.anyOf) {
		const options = schema.anyOf.map((option) => validate(option, value, source, path, depth + 1));
		if (!options.some((option) => option.length === 0))
			failures.push(`${path}: matches none of ${schema.anyOf.length} alternatives`);
	}
	for (const part of schema.allOf ?? []) failures.push(...validate(part, value, source, path, depth + 1));
	if (schema.oneOf) {
		const matching = schema.oneOf.filter((option) => validate(option, value, source, path, depth + 1).length === 0);
		if (matching.length !== 1)
			failures.push(
				`${path}: matches ${matching.length} of ${schema.oneOf.length} alternatives, exactly one required`,
			);
	}
	if (schema.not && validate(schema.not, value, source, path, depth + 1).length === 0)
		failures.push(`${path}: must not match ${JSON.stringify(schema.not)}`);
	if (failures.length > 0) return failures;
	// The bare null alternative, as above: nothing to it but `nullable`.
	if (schema.nullable === true && Object.keys(schema).every((key) => NULL_ONLY.has(key)))
		return value === null
			? []
			: [
					`${path}: expected null, got ${typeof value === "object" ? JSON.stringify(value).slice(0, 60) : String(value)}`,
				];
	if (schema.type) {
		const types = Array.isArray(schema.type) ? schema.type : [schema.type];
		const allowed = [...types, ...(schema.nullable ? ["null"] : [])];
		if (!allowed.some((type) => TYPE_OF[type]?.(value))) {
			return [
				`${path}: expected ${allowed.join(" or ")}, got ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`,
			];
		}
	}
	if (schema.enum && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
		return [`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum).slice(0, 120)}`];
	}
	if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
		return [`${path}: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`];
	}
	// Size limits, as draft 4 and OpenAPI 3.0 state them.
	const count = typeof value === "string" ? value.length : typeof value === "number" ? value : undefined;
	if (count !== undefined && value !== "") {
		if (schema.minimum !== undefined && count < schema.minimum)
			failures.push(`${path}: below the minimum ${schema.minimum}`);
		if (schema.exclusiveMinimum !== undefined && count <= schema.exclusiveMinimum)
			failures.push(`${path}: not above the minimum ${schema.exclusiveMinimum}`);
		if (schema.maximum !== undefined && count > schema.maximum)
			failures.push(`${path}: above the maximum ${schema.maximum}`);
	}
	if (typeof value === "string" && schema.maxLength !== undefined && value.length > schema.maxLength)
		failures.push(`${path}: longer than ${schema.maxLength} characters`);
	if (Array.isArray(value)) {
		if (schema.minItems !== undefined && value.length < schema.minItems)
			failures.push(`${path}: fewer than ${schema.minItems} items`);
		if (schema.maxItems !== undefined && value.length > schema.maxItems)
			failures.push(`${path}: more than ${schema.maxItems} items`);
		schema.prefixItems?.forEach((item, index) => {
			failures.push(...validate(item, value[index], source, `${path}[${index}]`, depth + 1));
		});
		if (schema.items === false) {
			const extra = value.length - (schema.prefixItems?.length ?? 0);
			if (extra > 0)
				failures.push(`${path}: ${extra} item(s) beyond the ${schema.prefixItems?.length ?? 0} allowed`);
		} else if (Array.isArray(schema.items)) {
			// Draft 4 writes the items of a tuple as a list.
			schema.items.forEach((item, index) => {
				failures.push(...validate(item, value[index], source, `${path}[${index}]`, depth + 1));
			});
		} else if (schema.items) {
			const from = schema.prefixItems?.length ?? 0;
			value.slice(from).forEach((item, offset) => {
				failures.push(...validate(schema.items as Schema, item, source, `${path}[${from + offset}]`, depth + 1));
			});
		}
	}
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		for (const name of schema.required ?? [])
			if (!(name in record)) failures.push(`${path}: required property ${name} is missing`);
		for (const [name, property] of Object.entries(schema.properties ?? {})) {
			if (name in record) failures.push(...validate(property, record[name], source, `${path}.${name}`, depth + 1));
		}
		const declared = new Set(Object.keys(schema.properties ?? {}));
		for (const name of Object.keys(record)) {
			if (declared.has(name)) continue;
			if (schema.additionalProperties === false) failures.push(`${path}: property ${name} is not allowed`);
			else if (typeof schema.additionalProperties === "object") {
				failures.push(...validate(schema.additionalProperties, record[name], source, `${path}.${name}`, depth + 1));
			}
		}
	}
	return failures;
}
