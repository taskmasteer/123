use serde_json::Value;
use super::AppError;
fn text(v:Option<&Value>,max:usize)->bool {v.and_then(Value::as_str).is_some_and(|s|!s.is_empty()&&s.len()<=max)}
fn id(v:Option<&Value>)->bool {v.and_then(Value::as_str).is_some_and(|s|s.len()==36&&s.bytes().enumerate().all(|(i,b)|if [8,13,18,23].contains(&i){b==b'-'}else{b.is_ascii_hexdigit()}))}
fn number(v:Option<&Value>,max:u64)->bool {v.and_then(Value::as_u64).is_some_and(|n|n<=max)}
pub fn validate(method:&str,value:&Value)->Result<(),AppError> {
 let bad=||AppError::new("Invalid visual request");let p=value.as_object().ok_or_else(bad)?;
 let allowed:&[&str]=match method {
  "visual.projection"=>&["siteId","expectedRevision"],"visual.projection.chunk"=>&["siteId","expectedRevision","mapId","index"],
  "visual.submit"=>&["siteId","expectedRevision","mapId","requestKey","patch"],"visual.status"=>&["siteId","saveId"],
  "visual.selection.begin"=>&["size","sha256"],"visual.selection.chunk"=>&["id","index","base64"],"visual.selection.open"=>&["id","documentPath"],
  "visual.selection.status"|"visual.selection.close"=>&["sessionId"],_=>return Err(bad())};
 if p.keys().any(|k|!allowed.contains(&k.as_str())){return Err(bad());}
 let valid=match method {
  "visual.projection"|"visual.projection.chunk"|"visual.submit"=>id(p.get("siteId"))&&number(p.get("expectedRevision"),9_007_199_254_740_991),
  "visual.status"=>id(p.get("siteId"))&&id(p.get("saveId")),
  "visual.selection.begin"=>number(p.get("size"),12_000_000)&&p.get("size").and_then(Value::as_u64).is_some_and(|n|n>0)&&p.get("sha256").and_then(Value::as_str).is_some_and(|s|s.len()==64&&s.bytes().all(|b|b.is_ascii_hexdigit())),
  "visual.selection.chunk"=>id(p.get("id"))&&number(p.get("index"),500)&&text(p.get("base64"),32000),
  "visual.selection.open"=>id(p.get("id"))&&p.get("documentPath").is_none_or(|v|text(Some(v),240)),
  _=>id(p.get("sessionId"))};if !valid{return Err(bad());}
 if method=="visual.projection.chunk"&&(!text(p.get("mapId"),160)||!number(p.get("index"),500)){return Err(bad());}
 if method=="visual.submit" {
  if !text(p.get("mapId"),160)||!text(p.get("requestKey"),100){return Err(bad());}let patch=p.get("patch").and_then(Value::as_object).ok_or_else(bad)?;
  if patch.len()<2||patch.keys().any(|k|!["elementId","text","href","imageAssetId","styles"].contains(&k.as_str()))||!patch.get("elementId").and_then(Value::as_str).is_some_and(|s|s.len()==66&&s.starts_with("e_")&&s[2..].bytes().all(|b|b.is_ascii_hexdigit())){return Err(bad());}
  for (key,max) in [("text",32000),("href",8192),("imageAssetId",64)]{if patch.get(key).is_some_and(|v|!v.as_str().is_some_and(|s|s.len()<=max)){return Err(bad());}}
  if let Some(styles)=patch.get("styles"){let s=styles.as_object().ok_or_else(bad)?;if s.is_empty()||s.iter().any(|(k,v)|!["color","backgroundColor","fontSize","margin","padding"].contains(&k.as_str())||!text(Some(v),512)){return Err(bad());}}
 }
 Ok(())
}
#[cfg(test)]mod tests{use super::*;use serde_json::json;#[test]fn narrow_visual_dtos(){let id="11111111-1111-4111-8111-111111111111";assert!(validate("visual.projection",&json!({"siteId":id,"expectedRevision":1})).is_ok());for p in [json!({"siteId":id,"expectedRevision":1,"role":"admin"}),json!({"siteId":id,"expectedRevision":-1}),json!({"siteId":"../../x","expectedRevision":1})]{assert!(validate("visual.projection",&p).is_err());}assert!(validate("visual.selection.open",&json!({"id":id,"url":"https://evil"})).is_err());assert!(validate("visual.submit",&json!({"siteId":id,"expectedRevision":1,"mapId":"map","requestKey":"key","patch":{"elementId":format!("e_{}","a".repeat(64)),"styles":{"background":"url(x)"}}})).is_err());}}
