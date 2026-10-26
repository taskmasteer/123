import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'tests/e2e',workers:1,use:{baseURL:'http://127.0.0.1:1420',viewport:{width:1280,height:800}},webServer:{command:'npm.cmd run dev --workspace @site-factory/desktop',url:'http://127.0.0.1:1420',reuseExistingServer:false},reporter:'list'});
