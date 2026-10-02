import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { AudioManager } from './AudioManager';
import { useAudioStore } from './audioStore';

/**
 * AudioController —— 音频生效闭环的挂载点（阶段 6，3.9）。
 * 置于 RequireAuth 内层：登录后拉设置起播（浏览器自动播放受限时首次交互后启动），
 * 路由切换 syncScene 切氛围曲。卸载（登出）时停曲释放资源。
 * 纯副作用组件，不渲染任何 DOM。
 */
export default function AudioController() {
  const location = useLocation();
  const init = useAudioStore((s) => s.init);

  useEffect(() => {
    init().catch(() => undefined); // 设置拉取失败静默（音频为增强体验，不阻塞页面）
  }, [init]);

  useEffect(() => {
    AudioManager.syncScene(location.pathname);
  }, [location.pathname]);

  useEffect(() => () => AudioManager.dispose(), []);

  return null;
}
