/** Commas separate memberships; slashes separate levels inside each category. */
export function securityCheckCategories(value: string): string[] {
	return [
		...new Set(
			value.split(/[,，]/).map((path) =>
				path
					.split("/")
					.map((part) => part.trim())
					.join("/"),
			),
		),
	];
}
