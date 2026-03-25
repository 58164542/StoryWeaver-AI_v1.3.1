import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');

    // 调试日志：查看是否加载了 ARK_API_KEY
    console.log('[Vite Config 调试] 环境变量加载:', {
      hasARK: 'ARK_API_KEY' in env,
      hasVITE_ARK: 'VITE_ARK_API_KEY' in env,
      ARK_value: env.ARK_API_KEY ? env.ARK_API_KEY.substring(0, 20) + '...' : 'UNDEFINED',
      VITE_ARK_value: env.VITE_ARK_API_KEY ? env.VITE_ARK_API_KEY.substring(0, 20) + '...' : 'UNDEFINED',
      allKeys: Object.keys(env).filter(k => k.includes('ARK') || k.includes('GRSAI') || k.toUpperCase().includes('UNIVIBE'))
    });

    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react()],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.ARK_API_KEY': JSON.stringify(env.VITE_ARK_API_KEY),
        'process.env.GRSAI_API_KEY': JSON.stringify(env.VITE_GRSAI_API_KEY),
        'process.env.NEX_API_KEY': JSON.stringify(env.NEX_API_KEY),
        'process.env.JARVIS_API_KEY': JSON.stringify(env.JARVIS_API_KEY),
        'process.env.BLTCY_API_KEY': JSON.stringify(env.BLTCY_API_KEY),
        'process.env.BLTCY_VIP_API_KEY': JSON.stringify(env.BLTCY_VIP_API_KEY),
        'process.env.BLTCY_WAN_API_KEY': JSON.stringify(env.BLTCY_WAN_API_KEY),
        'process.env.UNIVIBE_API_KEY': JSON.stringify(env.UNIVIBE_API_KEY || env.univibe_api_key || env.VITE_UNIVIBE_API_KEY),
        'process.env.univibe_api_key': JSON.stringify(env.univibe_api_key || env.UNIVIBE_API_KEY || env.VITE_UNIVIBE_API_KEY),
        'process.env.KLING_API_TOKEN': JSON.stringify(env.KLING_API_TOKEN),
        'process.env.KLING_API_KEY': JSON.stringify(env.KLING_API_KEY),
        'process.env.KLING_ACCESS_KEY': JSON.stringify(env.KLING_ACCESS_KEY),
        'process.env.KLING_SECRET_KEY': JSON.stringify(env.KLING_SECRET_KEY),
        'process.env.GITHUB_TOKEN': JSON.stringify(env.GITHUB_TOKEN),
        'process.env.GITHUB_OWNER': JSON.stringify(env.GITHUB_OWNER),
        'process.env.GITHUB_REPO': JSON.stringify(env.GITHUB_REPO),
        'process.env.GITHUB_BRANCH': JSON.stringify(env.GITHUB_BRANCH),
        'process.env.SEEDANCE_API_URL': JSON.stringify(env.SEEDANCE_API_URL || env.VITE_SEEDANCE_API_URL || 'http://localhost:3005'),
        'import.meta.env.VITE_SEEDANCE_API_URL': JSON.stringify(env.VITE_SEEDANCE_API_URL || env.SEEDANCE_API_URL || '')
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
