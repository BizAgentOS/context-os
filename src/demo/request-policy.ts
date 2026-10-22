/** Only saved-data reads and the scripted conversation/navigation lifecycle run in an online demo. */
const readOnlyPosts = new Set([
  '/api/live/query', '/api/semantic/query',
  '/api/canvas/context', '/api/canvas/context/read', '/api/canvas/message/receipt',
  '/api/canvas/navigate', '/api/canvas/message', '/api/canvas/stop',
]);

export function simulateDemoRequest(method: string, pathname: string) {
  return pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(method)
    && !(method === 'POST' && readOnlyPosts.has(pathname));
}

export const demoSimulation = {
  code: 'demo_simulated', simulated: true,
  error: '演示模拟：已收到这项操作；未保存变更、未发布版本，也未签发接入密钥。请在正式工作区完成实际操作。',
};
