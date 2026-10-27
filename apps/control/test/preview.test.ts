import {test,expect} from 'vitest';
import {projectPreview} from '../src/preview.js';
import {jwtVerify} from 'jose';
const scope={userId:'user',siteId:'site',revisionId:'revision',expiresAt:Math.floor(Date.now()/1000)+600},key=Buffer.alloc(32,8);
test('parse-aware preview rewrites static HTML/CSS/srcset references without changing archive bytes',async()=>{
 const file={path:'pages/index.html',mediaType:'text/html',bytes:Buffer.from('<h1 style="background:url(../asset.png)">Title</h1><link rel="stylesheet" href="/site.css"><img srcset="/asset.png 1x, ../asset.png 2x"><a href="../index.html#part">Back</a><a href="https://external.example">External</a>')};
 const css={path:'site.css',mediaType:'text/css',bytes:Buffer.from('@import "theme.css"; h1{background:url(asset.png)}')};
 const files=[file,css,...['asset.png','index.html','theme.css'].map(path=>({path,mediaType:'text/plain',bytes:Buffer.from('fixture')}))];const original=Buffer.from(file.bytes);
 const html=Buffer.from(await projectPreview(file,files,scope,key)).toString();expect(html).toContain('/preview/site/revision/site.css?asset=');expect(html).toContain('#part');expect(html).toContain('https://external.example');expect(file.bytes).toEqual(original);
 const projectedCss=Buffer.from(await projectPreview(css,files,scope,key)).toString();expect(projectedCss).toContain('/preview/site/revision/theme.css?asset=');expect(projectedCss).toContain('/preview/site/revision/asset.png?asset=');
 const match=/site\.css\?asset=([^"&]+)/.exec(html)!;const claims=(await jwtVerify(match[1]!,key,{audience:'site-preview-asset'})).payload;expect(claims.path).toBe('site.css');expect(claims.exp).toBe(scope.expiresAt);
});
test('preview rejects raw traversal, encoded separators, missing resources and unknown schemes',async()=>{
 for(const href of ['../../private.html','%2e%2e/private.html','asset%2fprivate.html','missing.css','javascript:alert(1)']){const file={path:'index.html',mediaType:'text/html',bytes:Buffer.from(`<link href="${href}">`)};await expect(projectPreview(file,[file],scope,key)).rejects.toBeInstanceOf(Error);}
});
