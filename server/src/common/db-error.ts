import { QueryFailedError } from 'typeorm';

/** 判断是否为 SQLite UNIQUE 约束冲突（better-sqlite3 驱动） */
export function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof QueryFailedError &&
    (String(e.message).includes('UNIQUE constraint failed') ||
      String((e.driverError as { code?: string } | undefined)?.code ?? '').includes(
        'SQLITE_CONSTRAINT',
      ))
  );
}
