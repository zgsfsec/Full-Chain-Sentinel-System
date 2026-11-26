/**
 * Business modeling: the per-session state, the instruction, and the two markers
 * the transcript shows.
 *
 * The tools are declared to the model in every conversation and in every
 * engineering task's worker, because modeling can be asked for in the
 * conversation ("帮我做业务建模") as well as by the button, and a tool that only a
 * button can mount cannot be reached that way. What keeps modeling out of
 * ordinary work is therefore the instruction the tools carry rather than their
 * absence: their descriptions and guideline lists open by saying they may only
 * be called when the operator or the task asked for business modeling.
 *
 * The button is only the instruction. It sends the briefing and starts a turn
 * on it; the run itself is opened by the agent's first accepted submission, so
 * a run that never gets that far leaves no record behind.
 *
 * The state lives on the branch as a `custom` entry, the way the mode, the
 * preset and the manual status do: it survives a restart, is inherited by a
 * fork, and never enters the model's context. Appending `null` clears it.
 *
 * What makes this module more than state is the briefing. Restoring an API from
 * traffic and reading a code base are both skills, and the model has not been
 * told how this console wants them done: the briefing says what to produce,
 * which of the two parts the inputs allow for, how to work through each, where
 * the entry points and the permission checks usually live in each stack it will
 * meet, and where the discipline is. It is also what `api_model_read` returns
 * for `part: "guide"`, which is how a worker dispatched by the commander gets it
 * without the commander copying it into the task.
 */

import type {
	SentinelApiModel,
	SentinelApiModelStatus,
	SentinelApiModelSummary,
	SentinelModelingState,
} from "./protocol.ts";

/**
 * The tools that write a record. They are declared in every conversation and
 * every engineering task's worker; a sub-agent and the commander get only the
 * read tool.
 */
export const MODELING_WRITE_TOOLS: readonly string[] = ["api_model_submit", "source_model_submit", "api_model_done"];

/** The read-only tool: the only modeling tool a sub-agent or the commander has. */
export const MODELING_READ_TOOLS: readonly string[] = ["api_model_read"];

/** Every modeling tool, in the order the model is shown them. */
export const MODELING_TOOLS: readonly string[] = [...MODELING_READ_TOOLS, ...MODELING_WRITE_TOOLS];

/** Custom entry recording that a modeling run is in force for this session. */
export const MODELING_STATE_CUSTOM_TYPE = "zg-modeling-state";

/** The injected briefing and the closing row, each rendered as a foldable marker row. */
export const MODELING_MESSAGE_CUSTOM_TYPE = "zg-modeling";

/** A run in force: the open record of this session, as the branch records it. */
export interface ModelingRun {
	runId: string;
}

/** The run one `zg-modeling-state` entry carries; `null` clears it. */
export function modelingRunFromEntry(data: unknown): ModelingRun | null | undefined {
	if (data === null) return null;
	if (typeof data !== "object") return undefined;
	const runId = (data as { runId?: unknown }).runId;
	if (typeof runId !== "string" || !runId) return undefined;
	return { runId };
}

/** The run set by the last state entry on a branch; null means modeling is off. */
export function readModelingRun(entries: readonly unknown[]): ModelingRun | null {
	let found: ModelingRun | null = null;
	for (const entry of entries) {
		const value = entry as { type?: string; customType?: string; data?: unknown };
		if (value.type !== "custom" || value.customType !== MODELING_STATE_CUSTOM_TYPE) continue;
		found = modelingRunFromEntry(value.data) ?? null;
	}
	return found;
}

/**
 * The tool set a session should have, given its current one. Every modeling
 * tool is always in it — a loadout restored from an older transcript that left
 * them out gets them back — so the model always knows modeling exists.
 *
 * The order of the untouched tools is preserved.
 */
export function modelingToolLoadout(active: readonly string[]): string[] {
	const kept = active.filter((name) => !MODELING_TOOLS.includes(name));
	return [...kept, ...MODELING_TOOLS];
}

const STATUS_LABELS: Record<SentinelApiModelStatus, string> = {
	modeling: "建模中",
	done: "完成",
	manual: "操作员结束",
	failed: "失败",
};

/**
 * One record as a line: what it covers, and the id to read it by. The briefing
 * lists the project's records in this form, and so does the read tool.
 */
export function modelingRecordLine(record: SentinelApiModelSummary): string {
	const scope = [record.target ? `目标 ${record.target}` : "", record.source ? `源码 ${record.source}` : ""].filter(
		(part) => part !== "",
	);
	const counts = [
		`${record.pathCount} 路径`,
		`${record.operationCount} 操作`,
		`${record.entityCount} 实体`,
		`${record.apiCount} 源码映射`,
		`${record.stateMachineCount} 状态机`,
		`${record.ruleCount} 规则`,
	].join(" / ");
	return `- ${record.title} [id: ${record.id}]（${STATUS_LABELS[record.status]}）${scope.length > 0 ? `${scope.join("，")}：` : ""}${counts}`;
}

/** How many existing records the briefing lists; the rest are counted. */
const MAX_LISTED_RECORDS = 20;

/** Where to look in each stack for the things the source mapping is made of. */
const STACK_HINTS: readonly string[] = [
	"- Java / Spring：入口看 @RestController、@Controller 上的 @RequestMapping / @GetMapping / @PostMapping，以及 RouterFunction 和 WebFlux 的函数式路由。权限看 @PreAuthorize / @Secured / @RolesAllowed、自定义注解（如 @RequiresPermission）、Spring Security 的 SecurityFilterChain 或 FilterSecurityInterceptor、HandlerInterceptor、@Aspect 切面、Filter。数据访问看 Mapper 接口与 XML、注解 SQL、JPA Repository、@Table 实体。外部调用看 RestTemplate、WebClient、Feign（@FeignClient）、@KafkaListener、RabbitTemplate、Dubbo。",
	"- Go：入口看 gin 的 r.GET / r.POST / r.Group、echo、chi，或标准库的 http.HandleFunc 与 ServeMux。handler → service → repository / dao → SQL 或 GORM 模型（TableName、column 标签）。权限看 r.Use 注册的中间件、自定义 middleware、handler 开头的判断。外部调用看 http.Client、grpc 客户端、MQ 客户端。",
	"- PHP：Laravel 的 routes/web.php 与 routes/api.php（Route::get、Route::resource、Route::apiResource）→ Controller → Service / Eloquent 模型（$table、$fillable）→ 迁移文件；权限看 middleware（auth、can）、Policy / Gate、FormRequest 的 authorize、控制器里的 authorize 调用。ThinkPHP 的 route 配置 → 控制器 → 模型 / Db::name；权限看 middleware 与控制器里的判断。外部调用看 Http 客户端、Guzzle、队列。",
	"- Python：Django 的 urls.py → 视图（函数视图，或 DRF 的 ViewSet 与 router.register）→ service → ORM 模型（models.Model 的字段与外键）；权限看 @login_required / @permission_required、middleware、DRF 的 permission_classes 与 get_permissions。Flask / FastAPI 的 @app.route / @router.get 与蓝图 → 视图 → SQLAlchemy 模型；权限看 before_request、装饰器、FastAPI 的依赖注入（Depends）。",
	"- Node：Express / Koa 的 app.get / router.post，NestJS 的 @Controller 与 @Get / @Post。权限看中间件（app.use、router.use）、NestJS 的 Guard 与自定义装饰器。数据访问看 TypeORM / Prisma / Sequelize / Mongoose 的模型与查询。外部调用看 axios / fetch、MQ 客户端。",
];

/**
 * The instruction: what the button injects, and what `api_model_read` returns
 * for `part: "guide"`. It is the whole briefing — what to produce, which of the
 * two parts the inputs allow for, the four tools, how to work, and where the
 * discipline is — and it names the records the project already has, so a new
 * run reads them instead of doing their work again.
 */
export function buildModelingBrief(projectName: string | null, records: readonly SentinelApiModelSummary[]): string {
	const source = projectName
		? `源码在当前项目「${projectName}」的工作目录里（容器内是 /work）。`
		: "源码在当前项目的工作目录里（容器内是 /work）。";
	const listed = records.slice(0, MAX_LISTED_RECORDS);
	const prior =
		listed.length > 0
			? [
					"本项目已有的业务建模记录：",
					...listed.map(modelingRecordLine),
					...(records.length > listed.length
						? [`- 另有 ${records.length - listed.length} 份未列出，用 api_model_read 查看全部。`]
						: []),
					"已有的记录先用 api_model_read 看它们覆盖了什么，不要重做：已经覆盖且没有变化的部分不用再交，本次只补缺的和变化的；与实际流量或源码冲突的，以实际为准。",
				]
			: ["本项目还没有业务建模记录。"];
	return [
		"【业务建模】现在开始业务建模。这与前面的渗透工作分开：目标是给当前项目的业务留下一份可用的模型。一次建模一条记录，记录分两部分，每部分做不做、依据是什么，由手上的输入决定：",
		"- 一、接口文档：一份 OpenAPI 3.0 文档，写明有哪些业务接口，以及每个接口的参数、请求体和响应结构；并整理出它背后的业务实体与关系。接口有两个来源：有流量就从流量还原，读源码就按源码里声明的写。",
		"- 二、读源码：读懂项目源码，交回每个接口在源码里的来龙去脉（API 源码映射），以及代码背后的业务逻辑（业务逻辑模型）。它们是给代码审计用的：越权、状态被跳过、资源归属没有校验这类逻辑问题，要靠这两份模型才看得清。",
		"先定范围（不要硬做，也不要猜）：",
		"- 有流量：还原接口文档。流量指会话里的抓包与代理记录、你刚才请求得到的响应，或操作员放进工作目录的抓包文件。接口的参数、请求体和响应结构都从实际响应里读。",
		`- 工作目录里有源码：读源码，交回源码映射和业务逻辑模型。同时把源码里声明的接口写进接口文档——路由、方法、参数、请求体、响应结构，照代码里写的填，每个接口的 description 开头注明「来自源码」。${source}`,
		"- 两样都有就都做，写进同一条记录。两边都有的接口以实际响应为准，只有源码的接口按源码里声明的写。",
		"- 两样都没有，或者范围说不清（多个仓库或模块、目标不明确）时，先问操作员一句；不要凭空生成。",
		"- 没有单独指定目标时，以本次会话里已经确认的目标为准。",
		...prior,
		"用这四个工具交回结果（它们平时也在工具表里，但只有操作员或任务指令要求建模时才该调用；本次是明确要求的）：",
		"- api_model_read：读本项目的业务建模记录。不传 id 列出全部；part=guide 可以随时取回这份指引。",
		'- api_model_submit：提交接口文档与业务实体，可以反复调用。有流量时写从流量还原的接口，读源码时写源码里声明的接口（description 开头注明「来自源码」）。两种形态——整份提交 { openapi: {...} }；分片提交 { paths: { "/a": {...} }, components: { schemas: {...} } }，按 key 合并进已有草稿（接口多的站点分片交，一次别塞太多）。同一个调用里可以用 entities 提交业务实体（name 必填，可带 fields / relations / description）。文档会被服务端校验（必须是 3.x、必须有 info.title / info.version 和 paths）；被拒绝时按返回的具体原因改，不要原样重试。',
		"- source_model_submit：提交源码映射与业务逻辑模型，可以反复、分批调用。接口映射放 apis，每个接口按「方法 + 路径」覆盖已提交的同一条；业务逻辑模型分五张表：entities（实体）、relations（关系）、stateMachines（状态机）、rules（前置条件 / 后置条件 / 业务不变量 / 资源所有权）、apiDependencies（跨接口依赖），各按自己的键覆盖。每条结论都要带代码位置（file + line，行号从 1 开始）。每个接口的 callChain、dataAccess、authChecks、externalCalls 四个数组必填，没有内容就给空数组。提交会被校验；被拒绝时按返回的具体原因改，不要原样重试。",
		"- api_model_done：声明结束。确认该提交的都提交了之后再调用。",
		"第一次提交就是这条记录的开始，所以第一次提交要带上内容：接口文档（或第一批 paths），或者源码模型（apis 或业务逻辑模型的某一张表）；可以用 title 给记录起名，用 target（流量目标）或 source（读的源码范围）写明范围。",
		"一、从流量还原接口文档（有流量时做）：",
		"1. 取证：用 bash 在容器里抓取与枚举（curl 请求页面与接口、翻前端 JS 找接口调用、按已有路径规律试探），操作员放进工作目录的抓包、文档也一并读。认证方式、参数、请求体、响应结构、错误码都从实际响应里读，不靠猜。",
		"2. 边确认边提交：第一次提交带上骨架（info + 公共的 components / securitySchemes）和第一个模块的端点，之后按模块分片补端点，中途被截断也不会丢掉已确认的部分。",
		"3. 实体与关系单独整理：站点业务里的对象（用户、订单、支付、文件……）写进 entities，关系写进 relations。实体是从接口证据归纳出来的，不是把 schemas 抄一遍。",
		"二、读源码（工作目录里有源码时做）：",
		"1. 先定位源码和范围：找到源码根目录，确认语言和框架、构建文件、启动入口。工作目录里有压缩包就先解包到一个目录再读。",
		"2. 再找入口：每个对外接口在源码里都有注册的地方。按技术栈去找：",
		...STACK_HINTS,
		"   其他技术栈照同样的思路：先找路由注册的地方，再顺着调用往下读。权限校验往往集中在少数几处（全局中间件、基类、切面、过滤器）：先找到它们，再判断某个接口有没有被覆盖到。",
		"3. 逐模块映射接口：从入口函数开始顺着调用往下读，直到落库和对外调用。每个接口提交一条：入口函数、调用链（每一层标明是 service / repository / util / middleware）、读写的表和字段、权限校验在哪一行（登录、权限、资源归属分开写）、外部调用。每批 10 到 20 个接口，边读边提交，中途被截断也不会丢掉已完成的部分。",
		"4. 把接口写进接口文档：每读完一个模块，用 api_model_submit 按模块提交这个模块的接口——路由、方法、参数、请求体和响应结构，照源码里声明的写，每个接口的 description 开头注明「来自源码」。源码映射记的是接口在代码里怎么走，接口文档记的是接口对外的形状，两份都要交。",
		"5. 归纳业务逻辑模型：表和领域类 → 实体（写明资源归属方）；外键和关联查询 → 关系；状态字段和它的枚举 → 状态机（每条迁移写清触发它的接口、前置条件、产生的结果）；代码里的校验、断言、限制 → 业务规则；接口之间的先后和依赖 → 跨接口依赖。不是 HTTP 接口的入口（定时任务、消息消费者、RPC 服务）如果也会改状态或数据，用状态机的 trigger 或业务规则记下来。",
		"收尾：在 api_model_done 里写清覆盖范围——接口文档覆盖了哪些模块、其中哪些来自流量哪些来自源码；源码映射和业务逻辑模型覆盖了哪些模块；哪些没覆盖、哪些只是推测。",
		"纪律：",
		"- 从流量还原的接口和字段，只提交实际验证过的；推测的内容要么不写，要么在 description 里注明「未验证」。",
		"- 从源码写进接口文档的，只写代码里写明的；代码里看不出来的（动态拼接的响应、按条件返回的结构）要么不写，要么注明「源码中未确认」。",
		"- 不要编造端点、参数或响应字段来把文档填满，宁缺毋滥。",
		"- 读源码的部分，只写读过的位置：file 和 line 是你亲眼看到的，不凭印象估行号。file 写相对项目工作目录的路径。",
		"- 没找到就写没找到：某个接口的调用链上没有权限校验，authChecks 给空数组并在 notes 里说明。这本身就是审计线索，不是遗漏。不要编造调用链、表或规则来把模型填满；从局部读到的内容推断出来的，标 inferred。",
		"- 不要把真实凭据（Cookie、Token、口令、密钥）写进记录，示例值用占位符。",
		"- 这一步是读与还原，不是利用：对目标不做破坏性操作，不运行目标代码，不改任何源文件。",
		"- 流量或源码拿不到时直接告诉操作员，不要凭空生成。",
		"- 结束后这些工具仍在工具表里，但没有要求时不要再调用；结束前不要去做与建模无关的工作。",
	].join("\n");
}

const END_LABELS: Record<Exclude<SentinelApiModelStatus, "modeling">, string> = {
	done: "完成",
	manual: "操作员结束",
	failed: "失败",
};

/**
 * The closing marker, injected so the transcript states how the run ended. It
 * counts the parts the record has: a record with only an interface document
 * reads the way it always did.
 */
export function buildModelingEndMessage(
	input: { status: Exclude<SentinelApiModelStatus, "modeling">; note?: string },
	record?: SentinelApiModel,
): string {
	const counts = [
		`${record?.pathCount ?? 0} 个路径`,
		`${record?.operationCount ?? 0} 个操作`,
		`${record?.entities.length ?? 0} 个业务实体`,
	];
	if (record && record.apis.length > 0) {
		counts.push(`${record.apis.length} 条源码映射`);
		if (record.logic.stateMachines.length > 0) counts.push(`${record.logic.stateMachines.length} 个状态机`);
		if (record.logic.rules.length > 0) counts.push(`${record.logic.rules.length} 条业务规则`);
	}
	const lines = [`【业务建模 · 结束】业务建模已结束（${END_LABELS[input.status]}）：已记录 ${counts.join(" / ")}。`];
	if (input.note?.trim()) lines.push(input.note.trim());
	lines.push("会话回到普通状态：建模工具仍在工具表里，但没有要求时不要再调用。");
	return lines.join("\n");
}

/** The live state the snapshot carries: the open record as it stands. */
export function modelingState(run: ModelingRun, record: SentinelApiModel): SentinelModelingState {
	return {
		runId: run.runId,
		title: record.title,
		target: record.target,
		source: record.source,
		startedAt: record.createdAt,
		pathCount: record.pathCount,
		operationCount: record.operationCount,
		entityCount: record.entities.length,
		apiCount: record.apis.length,
		stateMachineCount: record.logic.stateMachines.length,
		ruleCount: record.logic.rules.length,
	};
}
