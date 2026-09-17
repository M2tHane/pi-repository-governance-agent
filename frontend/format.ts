export const dateText = (value?:string|null) => value ? new Date(value).toLocaleString() : "—";
export const jobLabels:Record<string,string> = { PR_REVIEW:"PR 审查",REPLY_HANDLE:"回复复核",DECISION_EXTRACT:"规则提取",HEALTH_AUDIT:"健康检查" };
