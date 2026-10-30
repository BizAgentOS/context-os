import { openDatabase } from '../../src/knowledge/database.ts';

const command = process.argv[2];
if (!['init', 'reset-development'].includes(command)) throw new Error('用法：database.ts init | reset-development --confirm-delete-knowledge-schema');
if (command === 'reset-development' && (!process.argv.includes('--confirm-delete-knowledge-schema') || process.env.NODE_ENV === 'production')) throw new Error('重建仅限开发环境，必须显式确认删除 knowledge schema');
const db = await openDatabase(process.env.CONTEXT_OS_KNOWLEDGE_DATABASE_URL ?? '');
try {
  if (command === 'reset-development') await db.transaction(async sql => {
    await sql.query('DROP SCHEMA IF EXISTS knowledge CASCADE');
    await sql.query('DELETE FROM knowledge_schema_versions WHERE version=1');
  });
  await db.initialize();
  process.stdout.write('知识核心 schema 已初始化。\n');
} finally { await db.close(); }
