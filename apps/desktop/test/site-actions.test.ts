import {test,expect} from 'vitest';import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {canCancelJob,type DesktopSite} from '../src/features/sites/SiteList.js';import {ChatPanel} from '../src/features/editor/ChatPanel.js';
const site={ownerId:'owner',assignedUserIds:['assigned'],job:{kind:'generate',state:'running'}} as DesktopSite;
test('contextual cancellation follows own-generation and scoped spec-user edit roles',()=>{
 expect(canCancelJob(site,{userId:'owner',role:'user'},true)).toBe(true);expect(canCancelJob(site,{userId:'assigned',role:'spec-user'},true)).toBe(false);expect(canCancelJob(site,{userId:'foreign',role:'admin'},true)).toBe(true);
 const edit={...site,job:{...site.job!,kind:'edit' as const}};expect(canCancelJob(edit,{userId:'assigned',role:'spec-user'},true)).toBe(true);expect(canCancelJob(edit,{userId:'foreign',role:'spec-user'},true)).toBe(false);expect(canCancelJob(edit,{userId:'owner',role:'user'},true)).toBe(false);expect(canCancelJob({...site,job:{...site.job!,state:'completed'}},{userId:'owner',role:'admin'},true)).toBe(false);
});
test('managed queue mode enables compose independently of local blocked controls and uses neutral persistence copy',()=>{
 const props={messages:[],instruction:'A meaningful instruction',setInstruction:()=>{},onSend:()=>{},busy:false,refinement:false,onResetBase:()=>{}};
 expect(renderToStaticMarkup(React.createElement(ChatPanel,{...props,modelMode:'blocked'}))).toMatch(/<button[^>]*disabled[^>]*type="submit"/);const managed=renderToStaticMarkup(React.createElement(ChatPanel,{...props,modelMode:'managed'}));expect(managed).not.toMatch(/disabled/);expect(managed).toContain('История сохраняется вместе с сайтом');expect(managed).toContain('локальные ключи панели не нужны');
});
