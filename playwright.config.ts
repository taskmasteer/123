import {defineConfig} from '@playwright/test';
const environment=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));if(environment.NO_COLOR!==undefined)delete environment.FORCE_COLOR;
export default defineConfig({testDir:'tests/e2e',workers:1,use:{baseURL:'http://127.0.0.1:1420',viewport:{width:1280,height:800}},webServer:{command:'node scripts/desktop-web.mjs dev',env:environment,url:'http://127.0.0.1:1420',reuseExistingServer:false},reporter:'list'});
