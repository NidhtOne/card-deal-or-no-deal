import { isAbsolute, resolve } from 'path';

/**
 * server 包根目录。
 * 源码（src/config）与编译产物（dist/config）目录层级一致，向上两级均为 server/。
 */
export const SERVER_ROOT = resolve(__dirname, '..', '..');

/** monorepo 仓库根目录（server/ 的上一级） */
export const REPO_ROOT = resolve(SERVER_ROOT, '..');

/**
 * 将配置中的路径解析为绝对路径：
 * 相对路径一律基于仓库根目录（与 .env.example 中 ./data/game.db 等约定一致），绝对路径原样返回。
 */
export function resolveFromRoot(p: string): string {
  return isAbsolute(p) ? p : resolve(REPO_ROOT, p);
}
