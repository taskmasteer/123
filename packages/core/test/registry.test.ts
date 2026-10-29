import {test,expect} from 'vitest';
import {registryProjection,safeTopic} from '../../contracts/src/registry.js';
import type {Site,Job} from '../../contracts/src/model.js';
const site={input:{domain:'a.test',about:'Exact supplied concept'},domain:'a.test'} as Site;
const job={state:'needs_attention',stage:'validate'} as Job;
test('projects manual and checkpointed auto topics with bounded classified current errors',()=>{
 expect(registryProjection(site,job,{topic:'Different auto',diagnostic:'validation_failed',error:'Bearer secret'})).toEqual({topic:'Exact supplied concept',latestError:{code:'validation_failed',message:'Страница не прошла проверку.'}});
 expect(registryProjection({...site,input:{domain:'a.test'}},job,{topic:'A model invented concept',diagnostic:'publication_failed'}).topic).toBe('A model invented concept');
 expect(registryProjection(site,{...job,state:'queued'},{diagnostic:'validation_failed'}).latestError).toBeNull();
 expect(registryProjection(site,{...job,state:'needs_attention',stage:'publication'},{diagnostic:'untrusted raw api key'}).latestError?.code).toBe('publication_failed');
 expect(safeTopic('a'.repeat(10000))?.length).toBe(300);for(const secret of ['Bearer abc123','sk-verysecret123','api_key=secret','password: secret'])expect(safeTopic(secret)).toBeNull();
});
