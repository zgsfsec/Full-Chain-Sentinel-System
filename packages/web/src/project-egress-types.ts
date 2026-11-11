/** The last successful, explicitly requested public IP measurement for a project. */
export interface ProjectEgressIp {
	ip: string;
	/** Absent on results saved before geographic lookup was added. */
	location?: string;
	testedAt: number;
}
