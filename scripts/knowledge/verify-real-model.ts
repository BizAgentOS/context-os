/** Retired: the old smoke script implicitly merged shared identities without review.
 * Use verify-build-plans.ts and the manual review workflow instead. No model calls are made here.
 */
throw new Error('旧验证脚本使用未经审核的共享身份，已停用；请使用 scripts/knowledge/verify-build-plans.ts 生成候选并进行人工审核。');
