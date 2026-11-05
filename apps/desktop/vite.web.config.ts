import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({plugins:[tailwindcss()],build:{outDir:'dist-web',rollupOptions:{input:'web.html'}},server:{host:'127.0.0.1',port:4311,proxy:{'/api':'http://127.0.0.1:4310','/auth':'http://127.0.0.1:4310','/preview':'http://127.0.0.1:4310'}}});
