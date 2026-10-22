/** Runtime names use Context OS; previous deployment variables remain supported. */
export const PRODUCT_NAME = 'Context OS';
export const PRODUCT_ID = 'context-os';
export function environment(name: string, values: NodeJS.ProcessEnv = process.env): string | undefined {
  return values[`CONTEXT_OS_${name}`] ?? values[`DATAENGINE_${name}`] ?? values[`ADE_${name}`];
}
