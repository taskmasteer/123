
import {test,expect} from 'vitest';
import {jobDiagnostic} from '../src/job-diagnostic.js';
import type {Job} from '../../../packages/contracts/src/model.js';
const job={id:'job',kind:'generate',state:'needs_attention',stage:'validate',siteId:'site',checkpointId:'point',baseRevision:0} as Job;
test('validation failure explains the next step without offering an invalid retry',()=>{const d=jobDiagnostic(job,{error:'Validation failed after two repairs.',validation:{ok:false,issues:[{code:'readability',message:'PRIVATE_RAW_DETAIL'}]}})!;expect(d.retryable).toBe(false);expect(d.issues[0]).toContain('контрастный');expect(JSON.stringify(d)).not.toContain('PRIVATE_RAW_DETAIL');});
test('unknown diagnostic never exposes raw provider secrets',()=>{expect(JSON.stringify(jobDiagnostic(job,{error:'secret-token-123'}))).not.toContain('secret-token-123');expect(jobDiagnostic({...job,state:'completed'})).toBeNull();});
test('a publication-policy rejection identifies the issue without exposing file contents',()=>{
 const d=jobDiagnostic(job,{error:'Static publication checks failed.',validation:{issues:[{code:'secret',message:'PRIVATE_RAW_DETAIL'}]}})!;
 expect(d.code).toBe('publication_policy');expect(d.issues[0]).toContain('ключ');expect(d.retryable).toBe(false);
 expect(JSON.stringify(d)).not.toContain('PRIVATE_RAW_DETAIL');
});
