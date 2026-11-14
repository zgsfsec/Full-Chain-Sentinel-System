/** Disk usage attributable to one project; shared images and databases are excluded. */
export interface ProjectStorageUsage {
	bytes: number;
	hostBytes: number;
	containerBytes: number;
	/** Some directories or container sizes could not be read. */
	partial: boolean;
	measuredAt: number;
}
