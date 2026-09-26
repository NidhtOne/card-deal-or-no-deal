/**
 * 集成测试环境变量：必须在任何模块导入前生效
 * （data-source.ts / auth.module.ts 在 import 时读取 process.env）。
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'integration-test-jwt-secret';
process.env.DATABASE_URL = './data/test-integration.db';
