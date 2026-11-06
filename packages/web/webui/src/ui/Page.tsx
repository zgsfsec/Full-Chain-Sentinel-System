/**
 * The page frame every console page uses.
 *
 * Title, one-line description, actions on the right, optional tabs, then the
 * body. Keeping this in one place is what makes twenty-five pages look like one
 * product: spacing, type scale and action placement stop being a per-page
 * decision.
 *
 * The body is the caller's; pages that mostly show a table usually pass a
 * `ProTable` as children and nothing else.
 */

import { Flex, Typography } from "antd";
import type { ReactNode } from "react";

const { Title, Text } = Typography;

export function Page({
	title,
	description,
	extra,
	tabs,
	children,
	className,
}: {
	title: ReactNode;
	description?: ReactNode;
	/** Primary actions for the page, right-aligned on the title row. */
	extra?: ReactNode;
	/** A tab bar rendered under the title, typically `Tabs` or `Segmented`. */
	tabs?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={className ? `ui-page ${className}` : "ui-page"}>
			<div className="ui-page__head">
				<Flex align="flex-start" justify="space-between" gap={16} wrap>
					<div className="ui-page__titles">
						<Title level={4} className="ui-page__title">
							{title}
						</Title>
						{description ? (
							<Text type="secondary" className="ui-page__desc">
								{description}
							</Text>
						) : null}
					</div>
					{extra ? <Flex className="ui-page__actions" align="center" gap={8} wrap>{extra}</Flex> : null}
				</Flex>
				{tabs ? <div className="ui-page__tabs">{tabs}</div> : null}
			</div>
			<div className="ui-page__body">{children}</div>
		</div>
	);
}

/**
 * A titled block inside a page.
 *
 * Used when a page mixes sections (a form above a table, two related lists):
 * the heading states what the block is, so the reader does not have to infer it
 * from the contents.
 */
export function Section({
	title,
	description,
	extra,
	children,
	className,
}: {
	title?: ReactNode;
	description?: ReactNode;
	extra?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<section className={className ? `ui-section ${className}` : "ui-section"}>
			{title || extra ? (
				<Flex align="center" justify="space-between" gap={12} wrap className="ui-section__head">
					<div>
						{title ? <Text strong>{title}</Text> : null}
						{description ? (
							<Text type="secondary" className="ui-section__desc">
								{description}
							</Text>
						) : null}
					</div>
					{extra}
				</Flex>
			) : null}
			{children}
		</section>
	);
}
