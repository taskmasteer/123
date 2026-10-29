import {sha256,targetInfo} from './package-runtime.mjs';
export function tauriPackageConfiguration(runtime,target,resourceSource=runtime){
 const info=targetInfo(target),mac=info.os==='darwin';
 return {build:{beforeBuildCommand:null},bundle:{active:true,targets:mac?['app','dmg']:['nsis'],...(mac?{macOS:{signingIdentity:'-',files:{'Resources/runtime':runtime}}}:{}),resources:mac?{}:{[resourceSource+'/']:'runtime/'}}};
}
/** Pinned Tauri CLI2.12.2 bundle.rs35–89: exact first bundle token patch. */
export function expectedNsisMain(original){
 const old=Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK'),replacement=Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS'),at=original.indexOf(old);
 if(at<0||at+old.length>original.length||!original.subarray(at,at+old.length).equals(old)||replacement.length!==old.length)throw Error('Expected original Tauri bundle marker missing or invalid.');
 const bytes=Buffer.from(original);replacement.copy(bytes,at);
 return {sha256:sha256(bytes),marker:'__TAURI_BUNDLE_TYPE_VAR_UNK→__TAURI_BUNDLE_TYPE_VAR_NSS',replacementCount:1,source:'https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.2/crates/tauri-bundler/src/bundle.rs#L35'};
}
